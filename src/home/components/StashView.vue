<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import StashPane from './StashPane.vue';
import { refreshCapture } from '../composables/capture.js';
import { useSell } from '../composables/sell.js';
import { ATTR_ZH, attrField } from '@/shared/lib/stats-zh.js';
import GameTooltip from '@/shared/components/GameTooltip.vue';

const props = defineProps ({
  charId: { type: String, default: '' },
  stashId: { type: String, default: '' },
  stackMode: { type: Boolean, default: false },
  includeInv: { type: Boolean, default: false },
  keepInPlace: { type: Boolean, default: true },
  requeryDebounce: { type: Number, default: 600 },
});
const emit = defineEmits ([ 'update:charId', 'update:stashId', 'update:equipment', 'update:active' ]);

const invoke = (ch, ...args) => window.electron.invoke (ch, ...args);

// ── 市场上架（网格点选） ──
const { pricing, selling, status, note, fetchPrices, startSell, stopSell } = useSell ();

// 历史查价价：canonical item id -> { price, ts }（仓库网格直接显示，无需再查）
const histPrices = ref (new Map ());

function toCanonicalId (raw) {
  const s = String (raw || '').replace (/^DesignDataItem:Id_Item_/, '');
  const m = s.match (/^id\.item\.(.*)$/i);
  const body = m ? m[1] : s;
  return 'id.item.' + body.replace (/([a-z])([A-Z])/g, '$1_$2').toLowerCase ();
}

async function loadHistPrices () {
  try {
    const ids = [];
    for (const s of Object.values (charData.value?.stashes || {})) {
      for (const it of (s?.items || [])) {
        if (it?.item_id) ids.push (it.item_id);
      }
    }
    if (!ids.length) return;
    const r = await invoke ('history:by-ids', ids);
    histPrices.value = new Map (Object.entries (r?.records || {}).map (([id, rec]) => [id, {
      price: rec.price,
      market: rec.market,
      vendor: rec.vendor,
      density: rec.density,
      ts: rec.ts,
      usedAffixes: rec.usedAffixes || [],
      attributes: rec.attributes || {},
    }]));
  } catch (e) {}
}

function histPriceOf (it) {
  return histPrices.value.get (toCanonicalId (it.item_id))?.price ?? null;
}

// 选中的待上架物品：uid(`${stashId}:${slotId}`) -> 物品数据副本（含 stash_id）
const sellSelected = ref (new Map ());

const sellSelectedList = computed (() =>
  [...sellSelected.value.values ()].sort (
    (a, b) => parseInt (a.stash_id) - parseInt (b.stash_id) || a.y - b.y || a.x - b.x
  )
);

const pricedSellCount = computed (() =>
  [...sellSelected.value.values ()].filter (i => sellPriceOf (i) != null).length
);

function sellKey (sid, slotId) { return `${sid}:${slotId}`; }

function isSellPicked (it) {
  return sellSelected.value.has (sellKey (props.stashId, it.slot_id));
}

// 上架价：本次查价结果优先；未查价的物品复用查价记录价（已查过 → 直接上架）
function sellPriceOf (it) {
  const sel = sellSelected.value.get (sellKey (props.stashId, it.slot_id));
  if (sel?.price != null) return sel.price;
  const hist = histPrices.value.get (toCanonicalId (it.item_id));
  return hist?.price ?? null;
}

// Shift 批量选择：记录上次点选的物品，Shift+单击时按格子顺序全选区间
const lastPickedSlot = ref (null);
const lastPickedStash = ref ('');

function toggleSellPick (it, e) {
  const key = sellKey (props.stashId, it.slot_id);

  if (e?.shiftKey && lastPickedSlot.value != null && lastPickedStash.value === props.stashId) {
    const sorted = [...(currentStash.value?.items || [])].sort ((a, b) => a.y - b.y || a.x - b.x);
    const idxA = sorted.findIndex (t => t.slot_id === lastPickedSlot.value);
    const idxB = sorted.findIndex (t => t.slot_id === it.slot_id);
    if (idxA >= 0 && idxB >= 0) {
      const [lo, hi] = idxA <= idxB ? [idxA, idxB] : [idxB, idxA];
      const m = new Map (sellSelected.value);
      for (let i = lo; i <= hi; i++) {
        const t = sorted[i];
        m.set (sellKey (props.stashId, t.slot_id), { ...t, stash_id: props.stashId, uid: sellKey (props.stashId, t.slot_id) });
      }
      sellSelected.value = m;
    }
    lastPickedSlot.value = it.slot_id;
    return;
  }

  lastPickedSlot.value = it.slot_id;
  lastPickedStash.value = props.stashId;
  const m = new Map (sellSelected.value);
  if (m.has (key)) m.delete (key);
  else m.set (key, { ...it, stash_id: props.stashId, uid: key });
  sellSelected.value = m;
}

// ── tooltip（右键固定显示） ──
const hoverItem = ref (null);
const gridElRef = ref (null);

// ── 左键框选批量选择 ──
const selBox = ref (null);        // { left, top, width, height } 像素
let dragState = null;             // { x, y, active }
let suppressClickUntil = 0;

function onGridMouseDown (e) {
  if (e.button !== 0 || isEquipment.value) return;
  dragState = { x: e.clientX, y: e.clientY, active: false };
}

function onGridMouseMove (e) {
  if (!dragState || !gridElRef.value) return;
  if (!dragState.active && Math.hypot (e.clientX - dragState.x, e.clientY - dragState.y) > 6) {
    dragState.active = true;
  }
  if (dragState.active) {
    const r = gridElRef.value.getBoundingClientRect ();
    const x1 = dragState.x - r.left;
    const y1 = dragState.y - r.top;
    const x2 = e.clientX - r.left;
    const y2 = e.clientY - r.top;
    selBox.value = {
      left: Math.min (x1, x2),
      top: Math.min (y1, y2),
      width: Math.abs (x2 - x1),
      height: Math.abs (y2 - y1),
    };
  }
}

function onGridMouseUp () {
  if (!dragState) return;
  if (dragState.active && selBox.value) {
    applyBoxSelect ();
    // 抑制拖拽结束后的 click（避免误切换刚框选到的物品）
    suppressClickUntil = Date.now () + 250;
  }
  dragState = null;
  selBox.value = null;
}

function onGridMouseLeave () {
  dragState = null;
  selBox.value = null;
}

function isSuppressedClick () {
  return Date.now () < suppressClickUntil;
}

// 框选区域（像素）转格子坐标，选中所有与之相交的物品（追加到现有选择）
function applyBoxSelect () {
  const box = selBox.value;
  if (!box || !gridElRef.value) return;
  const cell = CELL + GAP;
  const gx1 = Math.floor (box.left / cell);
  const gy1 = Math.floor (box.top / cell);
  const gx2 = Math.floor ((box.left + box.width) / cell);
  const gy2 = Math.floor ((box.top + box.height) / cell);
  const m = new Map (sellSelected.value);
  let changed = false;
  for (const it of (currentStash.value?.items || [])) {
    const ix = it.x, iy = it.y, iw = it.width || 1, ih = it.height || 1;
    if (ix < gx2 && ix + iw > gx1 && iy < gy2 && iy + ih > gy1) {
      const key = sellKey (props.stashId, it.slot_id);
      if (!m.has (key)) {
        m.set (key, { ...it, stash_id: props.stashId, uid: key });
        changed = true;
      }
    }
  }
  if (changed) sellSelected.value = m;
}

function showTooltip (it, e) {
  // 固定在右键点击时的鼠标位置（不随鼠标移动）
  const x = e?.clientX ?? 0;
  const y = e?.clientY ?? 0;
  hoverTipLeft.value = x;
  hoverTipTop.value = y;
  const tipW = 250;
  hoverTipSide.value = (x + tipW + 40 > window.innerWidth) ? 'left' : 'right';
  hoverItem.value = it;
  tooltipSelected.value = new Map ();
  installTipCloseHandler ();
}

function closeTooltip () {
  hoverItem.value = null;
  tooltipSelected.value = new Map ();
  uninstallTipCloseHandler ();
}

// 全局点击非 tooltip 区域关闭（不拦截其他区域的点击/滚动）
let tipDocHandler = null;

function installTipCloseHandler () {
  if (tipDocHandler) return;
  tipDocHandler = (ev) => {
    if (!hoverItem.value) return;
    if (ev.target && ev.target.closest && ev.target.closest ('.tip-wrap')) return;
    closeTooltip ();
  };
  document.addEventListener ('mousedown', tipDocHandler);
}

function uninstallTipCloseHandler () {
  if (tipDocHandler) {
    document.removeEventListener ('mousedown', tipDocHandler);
    tipDocHandler = null;
  }
}

// 勾选点点击：切换该词条是否参与查价，然后按当前勾选组合重新查价
// 防抖 + 序列号：快速连续切换只对最后一次组合发请求，过期结果丢弃，查询期间可继续切换
let affixQueryTimer = null;
let affixQuerySeq = 0;

function onToggleSecondary (it, index) {
  const en = it.sp_en || [];
  const key = toCanonicalId (it.item_id);
  const rec = histPrices.value.get (key);
  // 默认不勾选（与游戏内悬浮窗一致：查价前空勾选，查询后勾选 = 实际使用的组合）
  const cur = new Set (tooltipSelected.value.get (key) || rec?.usedAffixes || []);
  const display = en[index]?.[0];
  if (display) {
    if (cur.has (display)) cur.delete (display);
    else cur.add (display);
  }
  tooltipSelected.value = new Map (tooltipSelected.value).set (key, cur);
  if (affixQueryTimer) clearTimeout (affixQueryTimer);
  const seq = ++affixQuerySeq;
  const spEn = en.filter ((item) => cur.has (item[0]));
  affixQueryTimer = setTimeout (async () => {
    tooltipBusy.value = true;
    try {
      // 切词条重查：只查勾选组合，无降级（与游戏内悬浮窗 requery 同一逻辑）
      const r = await invoke ('market:requery', { item_id: it.item_id, rarity: it.rarity, sp_en: spEn });
      if (seq !== affixQuerySeq) return; // 过期结果丢弃
      // 以本次组合的查询结果就地更新，tooltip 立即显示（组合恢复 AB 时直接显示 AB 价）
      if (r && r.price != null) {
        histPrices.value = new Map (histPrices.value).set (key, {
          price: r.price,
          ts: Date.now (),
          usedAffixes: r.usedAffixes?.length ? r.usedAffixes : [...cur],
          attributes: rec?.attributes || {},
        });
      }
    } catch (e) {}
    tooltipBusy.value = false;
  }, props.requeryDebounce);
}

// tooltip 操作按钮（内容内，与游戏内悬浮窗一致）
const tooltipBusy = ref (false);
const tooltipActions = computed (() => [
  { label: tooltipBusy.value ? '查询中…' : '查询价格', key: 'price' },
  { label: hoverItem.value && isSellPicked (hoverItem.value) ? '移出上架' : '加入上架', key: 'sell' },
]);

async function onTooltipAction (key) {
  const it = hoverItem.value;
  if (!it) return;
  if (key === 'sell') {
    toggleSellPick (it, null);
    return;
  }
  if (key === 'price') {
    if (tooltipBusy.value) return;
    tooltipBusy.value = true;
    try {
      const en = it.sp_en || [];
      const keyId = toCanonicalId (it.item_id);
      // 查询用全部词条（与游戏内 OCR 全词条一致，词条评分+降级在查价核心内完成）
      const target = { item_id: it.item_id, rarity: it.rarity, sp_en: en, primary_en: it.primary_en || [] };
      await fetchPrices ([target]);
      // 就地更新 tooltip 价格显示，勾选态 = 查询实际使用的组合（降级结果）
      if (target.price != null) {
        histPrices.value = new Map (histPrices.value).set (keyId, {
          price: target.price,
          ts: Date.now (),
          usedAffixes: target.usedAffixes?.length ? target.usedAffixes : [],
          attributes: histPrices.value.get (keyId)?.attributes || {},
        });
      }
    } catch (e) {}
    tooltipBusy.value = false;
  }
}

function hoverAttrCn (name) {
  const field = attrField (String (name).replace (/([a-z0-9])([A-Z])/g, '$1 $2'));
  return ATTR_ZH[field] || name;
}

// 悬停 tooltip 词条勾选的临时状态：canonicalId -> Set<DarkerDB display 名>
const tooltipSelected = ref (new Map ());

function hoverSecondary (it) {
  const key = toCanonicalId (it.item_id);
  const rec = histPrices.value.get (key);
  const temp = tooltipSelected.value.get (key);
  // 默认不勾选（与游戏内悬浮窗一致）；有临时勾选或历史实际组合时沿用
  const used = temp || new Set (rec?.usedAffixes || []);
  // 优先复用查价记录词条（含范围/等级，与游戏内悬浮窗一致）
  const sec = rec?.attributes?.secondary || [];
  if (sec.length && sec[0]?.display) {
    return sec.map (a => ({
      name: hoverAttrCn (a.display),
      value: a.value,
      selected: used.has (a.display),
      range: a.min != null && a.max != null && a.min !== a.max ? `${a.min} - ${a.max}` : '',
      grade: a.grade || '',
    }));
  }
  // 无记录 → 本地抓包词条
  const en = it.sp_en || [];
  return (it.sp || []).map ((item, i) => ({
    name: hoverAttrCn (item[0]),
    value: item[1],
    selected: used.has (en[i]?.[0]),
  }));
}

function hoverPrices (it) {
  const p = {};
  const rec = histPrices.value.get (toCanonicalId (it.item_id));
  if (rec) {
    if (rec.price != null) p.live = rec.price;       // 市场现价（最低挂单价）
    if (rec.market != null) p.market = rec.market;   // 市场均价（平均成交价）
    if (rec.vendor != null) p.vendor = rec.vendor;   // 商人回收
    if (rec.density != null) p.density = rec.density; // 每格价值
  }
  if (p.vendor == null && it.vendor_price) p.vendor = it.vendor_price;
  return p;
}

function rarityColorCss (r) { return (RARITY[r] || RARITY.Common).c; }

const hoverTipLeft = ref (0);
const hoverTipTop = ref (0);
const hoverTipSide = ref ('right');

function clearSellPick () {
  sellSelected.value = new Map ();
  lastPickedSlot.value = null;
  lastPickedStash.value = '';
}

function fmtSellG (it, v) {
  if (v == null) return '—';
  const compact = (it.width === 1 && it.height === 1) || (it.width === 1 && it.height === 2);
  return Number (v) + (compact ? '' : ' G');
}

// 上架自定义设置（自动上架页配置）
const sellCfg = ref ({ factor: 1, minPrice: 0, minRarity: '' });
const RARITY_RANK = { Poor: 0, Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Unique: 6, Artifact: 7 };

async function loadSellCfg () {
  try {
    const d = await invoke ('settings:get');
    const mp = parseInt (d.sell_min_price);
    sellCfg.value = {
      factor: parseFloat (d.sell_price_factor) || 1,
      minPrice: isNaN (mp) ? 200 : mp,
      minRarity: d.sell_min_rarity || '',
    };
  } catch (e) {}
}

// 稀有度筛选（神器 Artifact 一律禁止上架）
function sellFilterPass (it) {
  if (it.rarity === 'Artifact') return false;
  if (sellCfg.value.minRarity && (RARITY_RANK[it.rarity] ?? 0) < (RARITY_RANK[sellCfg.value.minRarity] ?? 0)) return false;
  return true;
}

// 上架价 = 市场价 × 系数（最低 1）
function finalSellPrice (raw) {
  return Math.max (1, Math.round ((raw ?? 0) * (sellCfg.value.factor || 1)));
}

// 整仓批量上架：选择仓库（可多选）→ 按稀有度筛选 → 查价 → 按最低价/系数上架
// 注意：batchStashOptions 依赖 stashList，必须定义在 stashList 之后（见下方）

async function doFetchSellPrices () {
  await loadSellCfg ();
  const targets = [...sellSelected.value.values ()].filter (sellFilterPass);
  if (!targets.length) {
    note.value = '当前列表没有符合条件的物品（检查稀有度设置）';
    return;
  }
  // 已有查价记录的物品直接复用记录价，不重复请求
  const toQuery = [];
  let reused = 0;
  for (const t of targets) {
    const hist = histPrices.value.get (toCanonicalId (t.item_id));
    if (hist?.price != null) {
      t.price = hist.price;
      reused++;
    } else {
      toQuery.push (t);
    }
  }
  if (toQuery.length) {
    pricing.value = true;
    note.value = `正在查询 ${toQuery.length} 件物品价格…`;
    await fetchPrices (toQuery);
    pricing.value = false;
  }
  // 批量查价后重载记录价：右键悬浮窗/网格显示立即用新价
  await loadHistPrices ();
  const withPrice = targets.filter (i => i.price != null).length;
  note.value = reused
    ? `价格就绪 ${withPrice} 件（复用记录 ${reused} 件）`
    : `价格就绪 ${withPrice} 件`;
}

async function doStartSell () {
  await loadSellCfg ();
  const artifactCount = sellSelectedList.value.filter (i => i.rarity === 'Artifact').length;
  const targets = sellSelectedList.value
    .map (i => ({ ...i, price: sellPriceOf (i) }))
    .filter (i => i.price != null)
    .filter (sellFilterPass)
    .filter (i => sellCfg.value.minPrice <= 0 || i.price >= sellCfg.value.minPrice);
  if (!targets.length) {
    note.value = sellSelectedList.value.length
      ? '没有符合条件（稀有度/最低价/神器）且有价的物品'
      : '请先查价，且至少一件物品有市场价';
    return;
  }
  note.value = artifactCount ? `跳过 ${artifactCount} 件神器，上架 ${targets.length} 件…` : `上架 ${targets.length} 件…`;
  const ok = await startSell (targets.map (i => ({
    stash_id: i.stash_id,
    x: i.x,
    y: i.y,
    w: i.width,
    h: i.height,
    price: finalSellPrice (i.price),
  })));
  if (ok !== false) clearSellPick ();
}

// 游戏内悬浮窗物品：加入/移出上架列表 / 直接上架当前物品
async function overlayAddItem (data, autoSell) {
  if (!charData.value || !data?.itemId) return;
  const canonTarget = toCanonicalId (data.itemId);
  for (const [sid, s] of Object.entries (charData.value.stashes || {})) {
    for (const it of (s?.items || [])) {
      if (toCanonicalId (it.item_id) === canonTarget) {
        if (autoSell) {
          // 列表有有价物品 → 上架整个列表；否则直接上架当前物品
          const listed = sellSelectedList.value.filter (i => i.price != null);
          if (listed.length) {
            doStartSell ();
          } else {
            if (it.rarity === 'Artifact') {
              note.value = '神器禁止上架';
              return;
            }
            await loadSellCfg ();
            if (!sellFilterPass ({ ...it, stash_id: sid })) {
              note.value = '该物品不满足稀有度设置，无法直接上架';
              return;
            }
            const price = data.price ?? null;
            if (price == null) {
              note.value = '无市场价，无法直接上架';
              return;
            }
            startSell ([{
              stash_id: sid,
              x: it.x,
              y: it.y,
              w: it.width || 1,
              h: it.height || 1,
              price: finalSellPrice (price),
            }]);
          }
          return;
        }
        // 加入/移出切换
        const key = sellKey (sid, it.slot_id);
        const m = new Map (sellSelected.value);
        if (m.has (key)) {
          m.delete (key);
          note.value = `已移出上架列表：${it.name}`;
        } else {
          m.set (key, { ...it, stash_id: sid, uid: key, price: data.price ?? null });
          note.value = `已加入上架列表：${it.name}`;
        }
        sellSelected.value = m;
        return;
      }
    }
  }
  note.value = '未在当前角色仓库中找到该物品';
}

// 上架列表数量变化 → 通知游戏内悬浮窗更新按钮文案
watch (() => sellSelected.value.size, (n) => {
  window.electron.send ('sell:list-count', { count: n });
});

// ── 仓库状态上报（悬浮球同步） ──
function reportStashState () {
  const list = stashList.value.map (s => ({ id: s.id, label: s.label }));
  const cur = list.find (s => s.id === props.stashId) || list[0] || null;
  invoke ('stash:set-current', {
    list,
    id: cur ? cur.id : null,
    label: cur ? cur.label : '',
  });
}

const characters = ref ([]);
const selected = ref (null);
const charData = ref (null);
const loading = ref (false);
const error = ref ('');
const activeCharacterId = ref ('');
const servicePort = ref (19528);

const CLASS_CN = {
  Barbarian: '野蛮人',
  Bard: '吟游诗人',
  Cleric: '牧师',
  Druid: '德鲁伊',
  Fighter: '战士',
  Ranger: '游侠',
  Rogue: '潜行者',
  Sorcerer: '术士',
  Warlock: '邪术师',
  Wizard: '法师',
};

const classIcons = import.meta.glob ('@assets/classes/*.avif', { eager: true, import: 'default' });
function classIcon (cls) {
  const f = `${(cls || '').toLowerCase ()}.avif`;
  const hit = Object.entries (classIcons).find (([k]) => k.endsWith (f));
  return hit ? hit[1] : '';
}

const RARITY = {
  Poor:      { c: '#8a8a8e', bg: 'rgba(138,138,142,0.10)' },
  Common:    { c: '#6e6e73', bg: 'rgba(0,0,0,0.05)' },
  Uncommon:  { c: '#4f9a00', bg: 'rgba(128,214,0,0.13)' },
  Rare:      { c: '#0084c8', bg: 'rgba(0,170,238,0.12)' },
  Epic:      { c: '#a445d6', bg: 'rgba(208,103,255,0.12)' },
  Legendary: { c: '#d97a00', bg: 'rgba(255,154,0,0.15)' },
  Unique:    { c: '#b08a2e', bg: 'rgba(236,217,154,0.30)' },
  Artifact:  { c: '#d92d20', bg: 'rgba(230,5,5,0.10)' },
};

const stashList = computed (() => {
  if (!charData.value || !charData.value.stashes) return [];
  return Object.entries (charData.value.stashes)
    .map (([id, s]) => ({ id, ...s }))
    .sort ((a, b) => parseInt (a.id) - parseInt (b.id));
});

const currentStash = computed (() =>
  stashList.value.find (s => s.id === props.stashId) || null
);

const isEquipment = computed (() => !!currentStash.value && currentStash.value.layout === 'equipment');

// ── 整仓批量上架（依赖 stashList，必须在其后定义） ──
const batchStashIds = ref ([]);
const batchPickerOpen = ref (false);
const sellMode = ref ('pick'); // pick=点选 / batch=批量

const sellPct = computed (() => {
  const total = status.value?.total || 0;
  const cur = status.value?.current || 0;
  return total ? Math.round (cur / total * 100) + '%' : '0%';
});

const batchStashOptions = computed (() =>
  stashList.value
    .filter (s => parseInt (s.id) >= 4 && s.items.length > 0)
    .map (s => ({ id: s.id, label: s.label, count: s.items.length }))
);

watch (stashList, () => {
  if (!batchStashIds.value.length) {
    const first = batchStashOptions.value[0];
    if (first) batchStashIds.value = [first.id];
  }
});

function toggleBatchStash (id) {
  const cur = new Set (batchStashIds.value);
  if (cur.has (id)) cur.delete (id);
  else cur.add (id);
  batchStashIds.value = [...cur];
}

async function startBatchSell () {
  if (!batchStashIds.value.length) return;
  await loadSellCfg ();
  let artifactCount = 0;
  const rawItems = [];
  for (const sid of batchStashIds.value) {
    const items = charData.value?.stashes?.[sid]?.items || [];
    artifactCount += items.filter (i => i.rarity === 'Artifact').length;
    rawItems.push (...items.map (it => ({ ...it, stash_id: sid })));
  }
  const candidates = rawItems.filter (sellFilterPass);
  if (!candidates.length) {
    note.value = artifactCount
      ? `所选仓库 ${artifactCount} 件物品均为神器，禁止上架`
      : '所选仓库没有符合稀有度设置的物品';
    return;
  }
  const targets = candidates.map (it => ({ ...it }));
  pricing.value = true;
  note.value = `跳过 ${artifactCount} 件神器，正在查询 ${targets.length} 件物品价格…`;
  await fetchPrices (targets);
  pricing.value = false;
  const okTargets = targets.filter (i =>
    i.price != null && (sellCfg.value.minPrice <= 0 || i.price >= sellCfg.value.minPrice)
  );
  if (!okTargets.length) {
    note.value = '没有符合条件（稀有度/最低价）且有价的物品';
    return;
  }
  note.value = `上架 ${okTargets.length} 件（跳过 ${artifactCount} 件神器）…`;
  await startSell (okTargets.map (i => ({
    stash_id: i.stash_id,
    x: i.x,
    y: i.y,
    w: i.width || 1,
    h: i.height || 1,
    price: finalSellPrice (i.price),
  })));
}

watch (currentStash, (s) => emit ('update:equipment', !!(s && s.layout === 'equipment')), { immediate: true });

// 选择仓库：仅切换前端显示，不联动游戏内标签（游戏内切换由鼠标钩子反向识别）
function selectTab (s) {
  emit ('update:stashId', s.id);
}

// ── 仓库锁定：锁定后全仓/跨仓整理跳过该仓库，单页整理不受影响 ──
const lockedSet = ref (new Set ());

function isLocked (id) {
  return lockedSet.value.has (parseInt (id));
}

async function loadLocks () {
  try {
    const r = await invoke ('dnd:stash-locks-get');
    lockedSet.value = new Set ((r?.locked || []).map (x => parseInt (x)));
  } catch (e) {}
}

async function toggleLock (id) {
  const sid = parseInt (id);
  const next = !lockedSet.value.has (sid);
  try {
    const r = await invoke ('dnd:stash-locks-set', sid, next);
    if (r && Array.isArray (r.locked)) {
      lockedSet.value = new Set (r.locked.map (x => parseInt (x)));
    } else {
      const s = new Set (lockedSet.value);
      if (next) s.add (sid); else s.delete (sid);
      lockedSet.value = s;
    }
  } catch (e) {}
}

// ── 跟随模式（在「仓库配置」页设置）：off=关闭 / click=鼠标钩子识别 / pixel=像素扫描识别
const followMode = ref ('click');
const scanBrights = ref ([]);
const scanLast = ref ('');
let followTimer = null;
let retryTimer = null;

async function loadFollowMode () {
  try {
    const d = await invoke ('settings:get');
    if (d && ['off', 'click', 'pixel'].includes (d.follow_mode)) followMode.value = d.follow_mode;
  } catch (e) {}
}

function applyFollowMode () {
  if (followTimer) { clearInterval (followTimer); followTimer = null; }
  if (followMode.value === 'pixel') {
    followTimer = setInterval (pollInGameTab, 1000);
    pollInGameTab ();
  }
}

async function pollInGameTab () {
  if (!document.hidden) {
    try {
      const r = await invoke ('stash:tab-scan');
      if (r && r.success) {
        if (Array.isArray (r.brights)) scanBrights.value = r.brights;
        if (r.stash_id) scanLast.value = String (r.stash_id);
        if (r.stash_id) {
          const sid = String (r.stash_id);
          const hit = stashList.value.find (s => String (s.id) === sid);
          if (hit && String (props.stashId) !== sid) {
            emit ('update:stashId', sid);
            invoke ('stash:set-current', { id: sid, label: hit.label });
          }
        }
      }
    } catch (e) {}
  }
}

// ── 排序方案 ──
const SORT_PRESETS = [
  {
    id: 'default', label: '默认整理',
    order: [
      { field: 'width', direction: 'desc' }, { field: 'height', direction: 'desc' },
      { field: 'name', direction: 'asc' },
      { field: 'slot', direction: 'desc' }, { field: 'rarity', direction: 'desc' },
    ],
  },
  {
    id: 'sized', label: '品质区分',
    groupMode: 'sized',
    order: [
      { field: 'name', direction: 'asc' },
      { field: 'width', direction: 'desc' }, { field: 'height', direction: 'desc' },
      { field: 'slot', direction: 'desc' }, { field: 'rarity', direction: 'desc' },
    ],
  },
  {
    id: 'category', label: '装备优先',
    groupMode: 'category',
    order: [
      { field: 'category', direction: 'asc' },
      { field: 'name', direction: 'asc' },
      { field: 'width', direction: 'desc' }, { field: 'height', direction: 'desc' },
      { field: 'rarity', direction: 'desc' },
    ],
  },
  {
    id: 'type', label: '分类摆放',
    groupMode: 'type',
    order: [
      { field: 'name', direction: 'asc' },
      { field: 'rarity', direction: 'desc' },
      { field: 'width', direction: 'desc' }, { field: 'height', direction: 'desc' },
    ],
  },
];

const sortPreset = ref ('type');

function samePreset (a, b) {
  if (!Array.isArray (a) || !Array.isArray (b)) return false;
  for (let i = 0; i < b.length; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.field !== y.field || x.direction !== y.direction) return false;
  }
  return true;
}

async function loadSortOrder () {
  try {
    const [d, g] = await Promise.all ([
      invoke ('dnd:sort-order-get'),
      invoke ('dnd:sort-group-get'),
    ]);
    if (g && g.mode === 'category') { sortPreset.value = 'category'; return; }
    if (g && g.mode === 'sized') { sortPreset.value = 'sized'; return; }
    if (g && g.mode === 'type') { sortPreset.value = 'type'; return; }
    if (d && Array.isArray (d.order)) {
      const hit = SORT_PRESETS.find (p => samePreset (d.order, p.order));
      sortPreset.value = hit ? hit.id : 'default';
    }
  } catch (e) {}
}

async function changePreset (id) {
  const p = SORT_PRESETS.find (o => o.id === id);
  if (!p) return;
  sortPreset.value = id;
  try {
    await invoke ('dnd:sort-order-set', p.order);
    await invoke ('dnd:sort-group-set', p.groupMode || 'none');
  } catch (e) {}
}

const CELL = 34, GAP = 2;
const bgCells = computed (() => {
  const s = currentStash.value;
  return s ? s.width * s.height : 0;
});

// ── 调试预览 ──
const debugPreview = ref (false);
const previewItems = ref ([]);
const previewLoading = ref (false);
const previewSteps = ref (null);

async function loadPreview () {
  if (!props.charId || !props.stashId) return;
  previewLoading.value = true;
  previewSteps.value = null;
  try {
    const r = await invoke ('dnd:sort-preview', {
      character_id: props.charId,
      stash_id: props.stashId,
      stack_mode: props.stackMode,
      include_inventory: props.includeInv,
      keep_in_place: props.keepInPlace,
    });
    if (r && Array.isArray (r.items)) {
      previewItems.value = r.items;
      previewSteps.value = typeof r.steps === 'number' ? r.steps : null;
      debugPreview.value = true;
    }
  } catch (e) {}
  previewLoading.value = false;
}

async function togglePreview () {
  if (debugPreview.value) {
    debugPreview.value = false;
    previewItems.value = [];
    previewSteps.value = null;
    return;
  }
  await loadPreview ();
}

// If the sort modes change while the preview is open, refresh it so the step
// count keeps matching what the real sort will do.
watch (
  () => [props.stackMode, props.includeInv, props.keepInPlace],
  () => { if (debugPreview.value) loadPreview (); }
);

function previewStyle (it) {
  const r = RARITY[it.rarity] || RARITY.Common;
  return {
    left: it.x * (CELL + GAP) + 'px',
    top: it.y * (CELL + GAP) + 'px',
    width: it.width * CELL + (it.width - 1) * GAP + 'px',
    height: it.height * CELL + (it.height - 1) * GAP + 'px',
    '--rc': r.c,
    '--rbg': r.bg,
  };
}

function rarityOf (it) { return RARITY[it.rarity] || RARITY.Common; }

function iconUrl (it) {
  if (!it.icon) return '';
  return `http://127.0.0.1:${servicePort.value}/stash/icon/${it.icon}`;
}

function itemStyle (it) {
  const r = rarityOf (it);
  return {
    left: it.x * (CELL + GAP) + 'px',
    top: it.y * (CELL + GAP) + 'px',
    width: it.width * CELL + (it.width - 1) * GAP + 'px',
    height: it.height * CELL + (it.height - 1) * GAP + 'px',
    '--rc': r.c,
    '--rbg': r.bg,
  };
}

function slotStyle (s) {
  return {
    left: s.x * (CELL + GAP) + 'px',
    top: s.y * (CELL + GAP) + 'px',
    width: s.w * CELL + (s.w - 1) * GAP + 'px',
    height: s.h * CELL + (s.h - 1) * GAP + 'px',
  };
}

function tabIconType (label) {
  if (label.startsWith ('仓库')) return 'chest';
  if (label.startsWith ('赛季共享') || label.startsWith ('共享仓库')) return 'star';
  return '';
}

let lastCharLoad = { id: null, ts: 0 };
let lastStashLoad = { id: null, ts: 0 };

async function loadCharData (id, silent = false, force = false) {
  // 去重：同一角色 2 秒内已加载则跳过——启动时 mounted + watch + WebSocket
  // onopen 都会触发（旧版同一角色重复请求 3 次）；force 用于失败重试
  const now = Date.now ();
  if (!force && id === lastCharLoad.id && now - lastCharLoad.ts < 2000) return false;
  lastCharLoad = { id, ts: now };
  if (!silent) { loading.value = true; error.value = ''; charData.value = null; }
  try {
    const d = await invoke ('dnd:character', id);
    if (d && !d.error) {
      charData.value = d;
      loadHistPrices ();
      if (!stashList.value.some (s => s.id === props.stashId)) {
        const first = stashList.value[0];
        if (first) emit ('update:stashId', first.id);
      }
      return true;
    }
    logger.warn ('loadCharData failed', { id, error: d?.error || 'empty response' });
  } catch (e) {
    logger.warn ('loadCharData exception', { id, error: e?.message || String (e) });
    if (!silent) error.value = '加载失败';
  }
  if (!silent) loading.value = false;
  return false;
}

async function selectCharacter (id) {
  if (selected.value === id) return;
  selected.value = id;
  emit ('update:charId', id);
  await loadCharData (id);
}

async function reloadCharacters () {
  selected.value = null;
  charData.value = null;
  emit ('update:charId', '');
  emit ('update:stashId', '');
  await loadCharacters ();
}

const onCharactersRefresh = () => reloadCharacters ();

const calibrating = ref (false);
const calibResult = ref (null); // { ok: boolean, text: string, hints: string[] } | null
const stashNextKey = ref ('Ctrl+E');

async function loadStashNextKey () {
  try {
    const d = await invoke ('settings:get');
    if (d?.stash_next_key) stashNextKey.value = d.stash_next_key;
  } catch (e) {}
}

async function firstCalibrate () {
  if (calibrating.value) return;
  calibrating.value = true;
  calibResult.value = null;
  // 校准会先启动抓包：中途补一次状态刷新，让抓包控制卡片及时亮起
  const midTimer = setTimeout (() => { if (calibrating.value) refreshCapture (); }, 2500);
  try {
    const r = await invoke ('stash:first-calibrate');
    if (r?.success) {
      calibResult.value = {
        ok: true,
        text: '仓库数据已就绪，选择角色后即可开始整理',
        hints: [
          `按快捷键 ${stashNextKey.value} 可快捷切换仓库`,
          '每次整理前确保软件内仓库与游戏内仓库一致；游戏内选择仓库可能识别错误，推荐用快捷键切换',
        ],
      };
      await reloadCharacters ();
      // 校准返回的角色 id 直接回填：标记「游戏中」+ 自动选中并加载数据（不依赖 WS 事件，事件可能先于监听发出或 cached 分支根本不广播）
      const cid = r.character_id;
      if (cid && characters.value.some (c => c.id === cid)) {
        activeCharacterId.value = cid;
        if (selected.value !== cid) selected.value = cid;
        if (props.charId !== cid) emit ('update:charId', cid);
        loadCharData (cid, true);
      }
      await loadCalibration ();
      await loadFollowCal ();
    } else {
      calibResult.value = { ok: false, text: r?.error || '校准失败，请确认游戏已启动并重试', hints: r?.hints || [] };
      await reloadCharacters ();
    }
  } catch (e) {
    calibResult.value = { ok: false, text: '校准失败：后端服务未就绪' };
  }
  clearTimeout (midTimer);
  await refreshCapture ();
  calibrating.value = false;
}

// ── 自定义：仓库标签校准（坐标 + 特征） ──
const tabCalExpand = ref (false);
const calItems = ref ([]);
const calPending = ref ([]);
const calSaving = ref (false);
const calNote = ref ('');
const fCalItems = ref ([]);
const fCalPending = ref ([]);
const autoCalBusy = ref (false);

async function loadCalibration () {
  try {
    const r = await invoke ('stash:calibration-status');
    if (r && Array.isArray (r.mapping)) {
      calItems.value = r.mapping.map ((t, i) => ({
        type: t,
        label: (r.labels && r.labels[i]) || String (t),
        saved: r.saved_positions && r.saved_positions[i],
      }));
      calPending.value = (r.pending || []).slice ();
    }
  } catch (e) {}
}

async function loadFollowCal () {
  try {
    const r = await invoke ('stash:follow-calibrate-status');
    if (r && Array.isArray (r.mapping)) {
      fCalItems.value = r.mapping.map ((t, i) => ({
        type: t,
        label: (r.labels && r.labels[i]) || String (t),
        saved: r.saved && r.saved[i],
      }));
      fCalPending.value = (r.pending || []).slice ();
    }
  } catch (e) {}
}

async function autoCalibrate () {
  if (autoCalBusy.value) return;
  autoCalBusy.value = true;
  calNote.value = '自动校准中：程序将依次点击游戏里的每个仓库标签并采样…请勿移动鼠标';
  try {
    const r = await invoke ('stash:follow-calibrate-auto');
    if (r && r.success) {
      calNote.value = '自动校准完成并已保存（特征）';
      await loadFollowCal ();
    } else if (r) {
      const msg = r.error === 'uipi_blocked' ? '鼠标模拟被拦截（需管理员权限运行 冒险者侍从）'
        : r.error === 'game_not_found' ? '未检测到游戏窗口，请先打开游戏仓库界面'
        : '自动校准失败：' + (r.error || '未知错误');
      calNote.value = msg;
    } else {
      calNote.value = '自动校准失败';
    }
  } catch (e) { calNote.value = '自动校准失败'; }
  autoCalBusy.value = false;
}

// ── 合并记录 / 保存 / 清除（坐标 + 特征一次完成） ──
async function recordBothCal (index) {
  calNote.value = '';
  const r1 = await invoke ('stash:calibration-record', index);
  const r2 = await invoke ('stash:follow-calibrate-record', index);
  if (r1 && r1.success) {
    const next = calPending.value.slice ();
    next[index] = { x: r1.x, y: r1.y };
    calPending.value = next;
  }
  if (r2 && r2.success) {
    const next = fCalPending.value.slice ();
    next[index] = { avg: r2.avg, gold: r2.gold };
    fCalPending.value = next;
  }
  if ((!r1 || !r1.success) && (!r2 || !r2.success)) calNote.value = '记录失败，请重试';
}

async function saveAllCal () {
  if (calSaving.value) return;
  calSaving.value = true;
  calNote.value = '';
  try {
    const pixel = followMode.value === 'pixel';
    const r1 = await invoke ('stash:calibration-save', '');
    const r2 = pixel ? await invoke ('stash:follow-calibrate-save') : null;
    if (r1 && r1.success && (!pixel || (r2 && r2.success))) {
      calNote.value = pixel ? '校准已保存（坐标 + 特征）' : '坐标校准已保存';
      await loadCalibration ();
      if (pixel) await loadFollowCal ();
    } else {
      const parts = [];
      if (r1 && Array.isArray (r1.missing)) parts.push (`坐标还有 ${r1.missing.length} 项未记录`);
      if (pixel && r2 && Array.isArray (r2.missing)) parts.push (`特征还有 ${r2.missing.length} 项未记录`);
      calNote.value = parts.join ('；') || '保存失败';
    }
  } catch (e) { calNote.value = '保存失败'; }
  calSaving.value = false;
}

async function resetAllCal () {
  calNote.value = '';
  await invoke ('stash:calibration-reset');
  await invoke ('stash:follow-calibrate-reset');
  await loadCalibration ();
  await loadFollowCal ();
}

// ── 标签点测（诊断） ──
const tabTesting = ref (false);
const tabTestNote = ref ('');

async function runTabTest () {
  tabTesting.value = true;
  tabTestNote.value = '请盯着游戏里的仓库标签栏，程序将每隔 1.5 秒自动点击一个标签…';
  try {
    const r = await invoke ('stash:tab-test', props.charId);
    if (r && r.success) {
      if (r.reason === 'uipi_blocked') {
        tabTestNote.value = '鼠标模拟被系统拦截（需管理员权限），点测无法执行';
      } else if (r.reason === 'game_not_found') {
        tabTestNote.value = '未检测到游戏窗口，点测未执行';
      } else {
        const order = (r.positions || []).map (p => `${p.label}@(${p.x},${p.y})`).join (' → ');
        tabTestNote.value = `点测完成（${r.positions.length} 格）：${order}。请把游戏里实际打开的仓库顺序告诉我。`;
      }
    } else {
      tabTestNote.value = '点测失败';
    }
  } catch (e) { tabTestNote.value = '点测失败'; }
  tabTesting.value = false;
}

async function loadCharacters () {
  try {
    const d = await invoke ('dnd:characters');
    characters.value = d?.characters || [];
    // 主动加载仓库数据：有角色必有仓库。props.charId 启动时可能已被
    // 恢复配置（非空），此时仍要加载；失败自动重试
    const targetId = props.charId || characters.value[0]?.id;
    if (characters.value.length && targetId && !charData.value) {
      if (!props.charId) emit ('update:charId', targetId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const ok = await loadCharData (targetId, true, attempt > 0);
        if (ok) break;
        await new Promise (r => setTimeout (r, 1200));
      }
    }
  } catch (e) {}
}

async function loadStashes () {
  if (!props.charId) { emit ('update:stashId', ''); return; }
  // 与 loadCharData 去重独立（共享会互相拦截导致仓库数据不加载）
  const now = Date.now ();
  if (props.charId === lastStashLoad.id && now - lastStashLoad.ts < 2000) return;
  lastStashLoad = { id: props.charId, ts: now };
  try {
    const d = await invoke ('dnd:character', props.charId);
    if (d && d.stashes) {
      const list = Object.entries (d.stashes)
        .map (([id, s]) => ({ id, label: s.label, count: s.items.length }))
        .sort ((a, b) => parseInt (a.id) - parseInt (b.id));
      if (!props.stashId || !list.some (s => s.id === props.stashId)) {
        const preferred = list.find (s => s.count > 0 && parseInt (s.id) >= 4)
          || list.find (s => s.count > 0)
          || list[0];
        if (preferred) emit ('update:stashId', preferred.id);
      }
    }
  } catch (e) {}
}

watch (() => props.charId, (v) => {
  clearSellPick ();
  if (v) {
    selected.value = v;
    loadCharData (v, true);
  } else {
    charData.value = null;
    selected.value = null;
  }
  loadStashes ();
});

watch (activeCharacterId, (v) => emit ('update:active', v));

let ws = null;
let wsRetry = null;
let wsClosed = false;
let unsubHist = null;

async function connectEvents () {
  if (ws || wsClosed) return;
  try {
    const port = await invoke ('dnd:service-port');
    ws = new WebSocket (`ws://127.0.0.1:${port}/stash/events`);
    ws.onmessage = async (ev) => {
      try {
        const m = JSON.parse (ev.data);
        if (m.type === 'current_character') {
          activeCharacterId.value = m.character_id || '';
        } else if (m.type === 'stash_switched') {
          if (followMode.value !== 'click') return;
          const sid = String (m.stash_id || '');
          const hit = stashList.value.find (s => String (s.id) === sid);
          if (hit) {
            emit ('update:stashId', sid);
            invoke ('stash:set-current', { id: sid, label: hit.label });
          }
        } else if (m.type === 'character_updated') {
          const cid = m.character_id || '';
          activeCharacterId.value = cid;
          try {
            const d = await invoke ('dnd:characters');
            if (d?.characters) characters.value = d.characters;
          } catch (e) {}
          if (cid && characters.value.some (c => c.id === cid)) {
            if (selected.value !== cid) selected.value = cid;
            if (props.charId !== cid) emit ('update:charId', cid);
            loadCharData (cid, true);
          }
        }
      } catch (e) {}
    };
    ws.onopen = () => {
      if (props.charId) loadCharData (props.charId, true);
    };
    ws.onclose = () => {
      ws = null;
      if (!wsClosed) wsRetry = setTimeout (connectEvents, 3000);
    };
    ws.onerror = () => { try { ws.close (); } catch (e) {} };
  } catch (e) {}
}

onMounted (async () => {
  await loadCharacters ();
  try { servicePort.value = await invoke ('dnd:service-port'); } catch (e) {}
  await loadSellCfg ();
  if (props.charId) {
    selected.value = props.charId;
    await loadCharData (props.charId);
  }
  loadSortOrder ();
  await loadFollowMode ();
  await loadLocks ();
  loadStashNextKey ();
  loadCalibration ();
  loadFollowCal ();
  window.addEventListener ('dnd:characters-refresh', onCharactersRefresh);
  // 任一处查价后刷新历史价（悬浮窗/仓库查价都会触发）
  unsubHist = window.electron.on ('history:updated', () => {
    if (charData.value) loadHistPrices ();
  });
  // 默认批量仓库选择（避免 setup 同步期访问未初始化数据）
  if (!batchStashIds.value.length) {
    const first = batchStashOptions.value[0];
    if (first) batchStashIds.value = [first.id];
  }
  // 游戏内悬浮窗「加入列表 / 开始上架」
  window.electron.on ('sell:add-item', (data) => overlayAddItem (data, false));
  window.electron.on ('sell:start-item', (data) => overlayAddItem (data, true));
  // 初始列表数量同步给悬浮窗
  window.electron.send ('sell:list-count', { count: sellSelected.value.size });
  connectEvents ();
  reportStashState ();
  applyFollowMode ();

  // 组件常驻（v-show）后不再随切换重建：启动时后端可能尚未就绪，
  // 就绪后统一补拉启动失败的数据（角色/锁/校准/排序配置/仓库）。
  let unsubOcr = null;
  unsubOcr = window.electron.on ('ocr:status', (d) => {
    if (!d?.ok) return;
    if (!characters.value.length) loadCharacters ();
    loadLocks ();
    loadCalibration ();
    loadFollowCal ();
    loadSortOrder ();
    // 角色已有但仓库数据缺失时补拉（启动超时后无其他重试路径）
    if (!charData.value && props.charId) loadCharData (props.charId, true);
    else loadStashes ();
  });
  retryTimer = setInterval (() => {
    if (!characters.value.length) loadCharacters ();
    else if (!charData.value && props.charId) loadCharData (props.charId, true);
    else if (retryTimer) { clearInterval (retryTimer); retryTimer = null; }
  }, 5000);
});

onBeforeUnmount (() => {
  if (followTimer) { clearInterval (followTimer); followTimer = null; }
  if (retryTimer) { clearInterval (retryTimer); retryTimer = null; }
  if (unsubOcr) unsubOcr ();
  if (unsubHist) unsubHist ();
  uninstallTipCloseHandler ();
  wsClosed = true;
  if (wsRetry) clearTimeout (wsRetry);
  if (ws) { try { ws.close (); } catch (e) {} ws = null; }
  window.removeEventListener ('dnd:characters-refresh', onCharactersRefresh);
});

watch (stashList, () => reportStashState ());
watch (() => props.stashId, () => reportStashState ());
</script>

<template>
  <div>
    <StashPane />

    <!-- 首次校准 -->
    <div class="calib-card card">
      <div class="calib-row">
        <div class="calib-left">
          <div class="calib-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><line x1="12" y1="1.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22.5" y2="12"/></svg>
          </div>
          <div class="calib-info">
            <div class="calib-t">首次校准</div>
            <div class="calib-d">{{ calibrating ? '正在启动抓包并在游戏内切换页面获取数据，请勿操作游戏…' : '一键完成：自动启动抓包 → 游戏内切页两次 → 获取仓库数据（首次整理前必做）' }}</div>
          </div>
        </div>
        <div class="calib-row-btns">
          <button class="btn primary" :disabled="calibrating" @click="firstCalibrate">
            {{ calibrating ? '校准中…' : '开始校准' }}
          </button>
          <button class="btn" :class="{ on: tabCalExpand }" @click="tabCalExpand = !tabCalExpand">
            自定义
          </button>
        </div>
      </div>
      <div v-if="calibResult" class="calib-result" :class="calibResult.ok ? 'ok' : 'err'">
        <svg v-if="calibResult.ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div class="calib-rbody">
          <div class="calib-rline"><b>{{ calibResult.ok ? '首次校准完成' : '校准未完成' }}</b>{{ calibResult.text }}</div>
          <ul v-if="calibResult.hints && calibResult.hints.length" class="calib-hints">
            <li v-for="(h, i) in calibResult.hints" :key="i">{{ h }}</li>
          </ul>
        </div>
      </div>

      <!-- 自定义：仓库标签校准 -->
      <template v-if="tabCalExpand">
        <div class="tabcal-head">
          <div class="tabcal-title">仓库标签校准</div>
          <div class="tabcal-desc" v-if="followMode === 'pixel'">点击坐标 + 选中态特征（像素跟随用）</div>
          <div class="tabcal-desc" v-else>标签点击坐标（切换 / 整理用）</div>
        </div>
        <div class="term-body">
          <p v-if="followMode === 'pixel'">手动：<b>先在游戏中点击该仓库标签</b>，再回来点「记录」——一次同时记录坐标与特征；也可用「一键自动校准」自动采集特征。</p>
          <p v-else>手动：<b>先在游戏中点击该仓库标签</b>，再回来点「记录」记录其坐标（坐标校准需手动完成，程序无法得知游戏内标签的真实位置）。</p>
        </div>
        <div v-if="followMode === 'pixel'" class="srow">
          <div class="srow-info">
            <div class="srow-t">一键自动校准</div>
            <div class="srow-d">自动逐标签点击采样特征，约 8 秒</div>
          </div>
          <div class="srow-ctl">
            <button class="btn primary" :disabled="autoCalBusy" @click="autoCalibrate">{{ autoCalBusy ? '自动校准中…' : '一键自动校准' }}</button>
          </div>
        </div>
        <div class="srow" v-for="(it, i) in calItems" :key="i">
          <div class="srow-info">
            <div class="srow-t">{{ it.label }}</div>
            <div class="srow-d">
              坐标：
              <template v-if="calPending[i]">待保存 ({{ calPending[i].x }}, {{ calPending[i].y }})</template>
              <template v-else-if="it.saved">已校准 ({{ it.saved.x }}, {{ it.saved.y }})</template>
              <template v-else>未校准</template>
              <template v-if="followMode === 'pixel'">
                <span class="cal-sep">·</span>特征：
                <template v-if="fCalPending[i]">待保存 ({{ fCalPending[i].avg }}, {{ fCalPending[i].gold }})</template>
                <template v-else-if="fCalItems[i] && fCalItems[i].saved">已校准 ({{ fCalItems[i].saved.avg }}, {{ fCalItems[i].saved.gold }})</template>
                <template v-else>未记录</template>
              </template>
            </div>
          </div>
          <div class="srow-ctl">
            <button class="btn sm" @click="recordBothCal(i)">记录</button>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">保存 / 清除</div>
            <div class="srow-d" v-if="followMode === 'pixel'">全部记录后保存；清除回退内置识别</div>
            <div class="srow-d" v-else>全部记录后保存；清除回退内置坐标</div>
          </div>
          <div class="srow-ctl">
            <button class="btn primary" :disabled="calSaving" @click="saveAllCal">{{ calSaving ? '保存中…' : '保存校准' }}</button>
            <button class="btn subtle" @click="resetAllCal">清除校准</button>
            <span v-if="calNote" class="cal-note">{{ calNote }}</span>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">标签点测（诊断）</div>
            <div class="srow-d">自动依次点击标签，核对切换顺序</div>
          </div>
          <div class="srow-ctl">
            <button class="btn sm" :disabled="tabTesting" @click="runTabTest">{{ tabTesting ? '点测中…' : '开始点测' }}</button>
          </div>
        </div>
        <div v-if="tabTestNote" class="term-body">
          <p>{{ tabTestNote }}</p>
        </div>
      </template>
    </div>

    <!-- 角色选择 -->
    <div class="sec" v-if="characters.length">
      <div class="sec-label">角色</div>
      <div class="char-row">
        <button v-for="c in characters" :key="c.id" class="char-card"
                :class="{ on: selected === c.id }" @click="selectCharacter (c.id)">
          <span class="char-seal"><img v-if="classIcon (c.class)" class="char-icon" :src="classIcon (c.class)" alt="" /></span>
          <span class="char-meta">
            <span class="char-name">{{ c.nickname }}</span>
            <span class="char-sub"><b>{{ CLASS_CN[c.class] || c.class }}</b> · Lv.<b>{{ c.level }}</b></span>
          </span>
          <span v-if="activeCharacterId === c.id" class="char-live">游戏中</span>
        </button>
      </div>
    </div>
    <div v-else class="empty-hint">
      <div class="empty-t">暂无角色数据</div>
      <div class="empty-d">点上方「开始校准」即可自动启动抓包并获取数据；也可以手动启动抓包后，在游戏大厅切换一次顶部栏页面（如切到商人页再切回），数据会自动出现在这里。整理前会自动刷新数据，无需重复操作。</div>
    </div>

    <!-- 仓库网格 -->
    <div v-if="charData && currentStash" class="sec">
      <div class="sec-label">{{ charData.nickname }} 的仓库</div>

      <div class="stash-layout">
        <div class="stash-side">
          <button v-for="s in stashList" :key="s.id" class="side-tab"
                  :class="{ active: props.stashId === s.id, locked: isLocked(s.id) }" @click="selectTab(s)"
                  :title="`${s.items.length} 件物品`">
            <span class="tab-ic">
              <svg v-if="tabIconType(s.label) === 'chest'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/><circle cx="12" cy="15" r="1" fill="currentColor" stroke="none"/></svg>
              <svg v-else-if="tabIconType(s.label) === 'star'" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
            </span>
            <span class="tab-label">{{ s.label }}</span>
            <span class="count">{{ s.items.length }}</span>
            <span v-if="parseInt(s.id) >= 4" class="lock-btn" :class="{ on: isLocked(s.id) }"
                  :title="isLocked(s.id) ? '已锁定：全仓/跨仓整理会跳过此仓库（仍可单页整理）。点击解锁' : '锁定后，全仓/跨仓整理会跳过此仓库（仍可单页整理）'"
                  @click.stop="toggleLock(s.id)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <template v-if="isLocked(s.id)">
                  <rect x="5" y="11" width="14" height="9" rx="2" fill="currentColor"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                </template>
                <template v-else>
                  <rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>
                </template>
              </svg>
            </span>
          </button>

          <!-- 上架面板（Apple/Fluent 风格） -->
          <div class="sell-panel">
            <div class="sp-head">
              <span class="sp-title">上架</span>
              <button class="sp-clear" v-if="sellSelected.size" @click="clearSellPick">清空</button>
            </div>

            <div class="sp-seg">
              <button :class="{ on: sellMode === 'pick' }" @click="sellMode = 'pick'">点选</button>
              <button :class="{ on: sellMode === 'batch' }" @click="sellMode = 'batch'">批量</button>
            </div>

            <div v-if="sellMode === 'pick'" class="sp-body">
              <button class="sp-btn" :class="{ on: !pricing && !selling && sellSelected.size > 0 }"
                      :disabled="pricing || selling || sellSelected.size === 0" @click="doFetchSellPrices">
                {{ pricing ? '查价中…' : `查询价格 ${sellSelected.size}` }}
              </button>
              <button class="sp-btn primary" :disabled="selling || pricedSellCount === 0" @click="doStartSell">
                {{ selling ? '上架中…' : `开始上架${pricedSellCount ? `（${pricedSellCount}）` : ''}` }}
              </button>
            </div>

            <div v-else class="sp-body">
              <button class="sp-btn" :class="{ on: batchPickerOpen }" @click="batchPickerOpen = !batchPickerOpen">
                选择仓库{{ batchStashIds.length ? `（${batchStashIds.length}）` : '' }}
              </button>
              <div v-if="batchPickerOpen" class="sp-picker">
                <label v-for="s in batchStashOptions" :key="s.id" :class="{ on: batchStashIds.includes (s.id) }">
                  <input type="checkbox" :checked="batchStashIds.includes (s.id)" @change="toggleBatchStash (s.id)" />
                  <span>{{ s.label }}</span><em>{{ s.count }}</em>
                </label>
                <div v-if="!batchStashOptions.length" class="sp-picker-empty">暂无可用仓库</div>
              </div>
              <button class="sp-btn primary" :disabled="pricing || selling || !batchStashIds.length" @click="startBatchSell">
                {{ pricing ? '查价中…' : (selling ? '上架中…' : '批量上架') }}
              </button>
            </div>

            <div v-if="selling" class="sp-progress">
              <div class="sp-bar"><div class="sp-bar-fill" :style="{ width: sellPct }"></div></div>
              <span>{{ status?.current || 0 }} / {{ status?.total || 0 }}</span>
              <button @click="stopSell">停止</button>
            </div>

            <div v-if="note" class="sp-note" :class="{ warn: note.indexOf ('失败') >= 0 }">{{ note }}</div>
          </div>
        </div>

        <div class="stash-body card">
        <div class="stash-meta">
          <div class="stash-preset">
            <span class="stash-k">排序方案</span>
            <div class="seg">
              <button v-for="o in SORT_PRESETS" :key="o.id"
                      class="seg-opt" :class="{ on: sortPreset === o.id }"
                      @click="changePreset(o.id)">
                <span class="seg-t">{{ o.label }}</span>
              </button>
            </div>
          </div>
          <div v-if="followMode === 'pixel' && scanBrights.length" class="scan-bar" :title="'命中仓库: ' + (scanLast || '无')">
            <span v-for="(b, i) in scanBrights" :key="i" class="scan-chip" :class="{ hot: b === Math.max(...scanBrights) }" :style="{ opacity: Math.max(0.25, Math.min(1, b / 200)) }">{{ b }}</span>
          </div>
          <button v-if="!isEquipment" class="debug-btn" :class="{ on: debugPreview }" :disabled="previewLoading" @click="togglePreview">
            {{ previewLoading ? '计算中…' : (debugPreview ? `预览中 · ${previewSteps ?? 0} 步` : '排序预览') }}
          </button>
        </div>

        <div class="grid-scroll"
             @mousedown="onGridMouseDown"
             @mousemove="onGridMouseMove"
             @mouseup="onGridMouseUp"
             @mouseleave="onGridMouseLeave"
             @selectstart.prevent
             @dragstart.prevent>
          <div class="stash-grid" ref="gridElRef"
               :style="{
                 width: currentStash.width * (34 + 2) - 2 + 'px',
                 height: currentStash.height * (34 + 2) - 2 + 'px',
               }">
            <div v-if="!isEquipment" class="grid-bg"
                 :style="{
                   gridTemplateColumns: `repeat(${currentStash.width}, 34px)`,
                   gridTemplateRows: `repeat(${currentStash.height}, 34px)`,
                 }">
              <span v-for="n in bgCells" :key="n" class="bg-cell"></span>
            </div>
            <div v-else class="equip-bg">
              <span v-for="s in currentStash.slots" :key="s.id" class="eq-slot"
                    :style="slotStyle (s)" :title="s.name"></span>
            </div>
            <div v-for="(it, i) in currentStash.items" :key="i" class="cell-item"
                 :class="{ hidden: debugPreview, 'sell-picked': isSellPicked(it) }"
                 :style="itemStyle (it)"
                 @click="!isEquipment && !isSuppressedClick() && toggleSellPick(it, $event)"
                 @contextmenu.prevent="!isEquipment && showTooltip(it, $event)">
              <img v-if="it.icon" class="item-icon" :src="iconUrl (it)" alt="" loading="lazy" />
              <span v-if="isSellPicked(it) && sellPriceOf(it) != null" class="cell-price">{{ fmtSellG (it, sellPriceOf (it)) }}</span>
              <span v-else-if="histPriceOf(it) != null" class="cell-price hist">{{ fmtSellG (it, histPriceOf (it)) }}</span>
            </div>
            <div v-if="selBox" class="sel-box"
                 :style="{ left: selBox.left + 'px', top: selBox.top + 'px', width: selBox.width + 'px', height: selBox.height + 'px' }"></div>
            <template v-if="debugPreview && previewItems.length">
              <div v-for="(pi, i) in previewItems" :key="'p'+i" class="preview-item"
                   :style="previewStyle (pi)" :title="pi.name">
                <img v-if="pi.icon" class="item-icon" :src="iconUrl (pi)" alt="" loading="lazy" />
              </div>
            </template>
          </div>
        </div>
        </div>
      </div>
    </div>

    <div v-else-if="loading" class="empty-hint"><div class="empty-t">加载中…</div></div>

    <!-- 右键显示的 tooltip（固定鼠标位置，点击其他区域关闭） -->
    <div v-if="hoverItem && !debugPreview" class="tip-wrap" :class="hoverTipSide"
         :style="{ left: hoverTipLeft + 'px', top: hoverTipTop + 'px' }">
      <GameTooltip
        :title="hoverItem.name"
        :title-color="rarityColorCss (hoverItem.rarity)"
        :secondary="hoverSecondary (hoverItem)"
        :prices="hoverPrices (hoverItem)"
        :actions="tooltipActions"
        @toggle-secondary="i => onToggleSecondary (hoverItem, i)"
        @action="onTooltipAction"
      />
    </div>
  </div>
</template>

<style scoped>
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* first-time calibration card */
.calib-card {
  display: flex; flex-direction: column;
  padding: 16px 18px; margin-bottom: 20px;
  animation: paneIn .32s var(--ease) both;
}
.calib-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.calib-left { display: flex; align-items: center; gap: 13px; }
.calib-ic {
  width: 38px; height: 38px; flex: none; display: grid; place-items: center;
  border-radius: 10px; color: #fff;
  background: linear-gradient(150deg, #2a8bf2, var(--accent) 50%, var(--accent-strong));
  box-shadow: 0 2px 7px rgba(0,113,227,0.32);
}
.calib-ic svg { width: 19px; height: 19px; }
.calib-t { font-size: 14.5px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.calib-d { margin-top: 3px; font-size: 12.5px; color: var(--text-3); line-height: 1.5; }
.calib-result {
  display: flex; align-items: flex-start; gap: 9px;
  margin-top: 13px; padding: 11px 13px;
  border-radius: 9px;
  font-size: 13px; font-weight: 550; line-height: 1.55;
  animation: paneIn .3s var(--ease) both;
}
.calib-result svg { width: 16px; height: 16px; flex: none; margin-top: 2px; }
.calib-result b { font-weight: 700; margin-right: 8px; }
.calib-result.ok { background: var(--green-soft); color: var(--green); border: 1px solid rgba(31,157,85,0.28); }
.calib-result.err { background: var(--red-soft); color: var(--red); border: 1px solid rgba(217,45,32,0.25); }
.calib-rbody { flex: 1; min-width: 0; }
.calib-hints { margin: 7px 0 0; padding: 0; list-style: none; }
.calib-hints li {
  position: relative; padding-left: 14px; margin-top: 4px;
  font-size: 12.5px; font-weight: 500; line-height: 1.5; opacity: .92;
}
.calib-hints li::before {
  content: ''; position: absolute; left: 2px; top: 7px;
  width: 4px; height: 4px; border-radius: 50%;
  background: currentColor; opacity: .75;
}

/* custom: stash tab calibration */
.calib-row-btns { display: flex; align-items: center; gap: 8px; flex: none; }
.calib-row-btns .btn.on {
  background: var(--accent); border-color: var(--accent); color: #fff;
  box-shadow: 0 2px 8px rgba(0,113,227,0.28);
}
.tabcal-head {
  margin-top: 14px; padding: 12px 16px 1px;
  border-top: 1px solid var(--line-soft);
}
.tabcal-title { font-size: 13.5px; font-weight: 650; color: var(--text); }
.tabcal-desc { margin-top: 3px; font-size: 12px; color: var(--text-3); line-height: 1.5; }
.cal-note { font-size: 12.5px; color: var(--green); }
.cal-sep { margin: 0 6px; color: var(--line); }

/* character cards */
.char-row { display: flex; flex-wrap: wrap; gap: 10px; }
.char-card {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 16px 11px 12px;
  background: var(--card); border: 1.5px solid var(--line-soft);
  border-radius: 11px; cursor: pointer; text-align: left;
  transition: transform .16s var(--ease), box-shadow .16s var(--ease), border-color .16s var(--ease), background .16s var(--ease);
}
.char-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-pop); border-color: var(--line); }
.char-card.on { border-color: var(--accent); background: var(--accent-softer); box-shadow: 0 0 0 1px var(--accent); }
.char-seal {
  width: 38px; height: 38px; flex: none; display: grid; place-items: center;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255,255,255,0.06);
}
.char-icon {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.char-meta { display: flex; flex-direction: column; gap: 2px; }
.char-name { font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
.char-card.on .char-name { color: var(--accent); }
.char-sub { font-size: 14px; color: var(--text-2); font-weight: 650; }
.char-sub b { font-weight: 700; color: inherit; }
.char-live {
  margin-left: auto; flex: none;
  font-size: 11px; font-weight: 650;
  color: #23c48e;
  background: rgba(35, 196, 142, 0.12);
  border: 1px solid rgba(35, 196, 142, 0.4);
  border-radius: 999px; padding: 2px 9px;
}

/* empty */
.empty-hint {
  padding: 44px 20px; text-align: center;
  background: var(--card); border: 1.5px dashed var(--line);
  border-radius: var(--r-card);
}
.empty-t { font-size: 15px; font-weight: 650; color: var(--text-2); }
.empty-d { margin-top: 7px; font-size: 13px; color: var(--text-3); line-height: 1.6; max-width: 420px; margin-left: auto; margin-right: auto; }

/* stash body */
.stash-layout { display: flex; gap: 12px; align-items: flex-start; }
.stash-side {
  flex: none; width: 200px;
  display: flex; flex-direction: column; gap: 8px;
}
.side-tab {
  display: flex; align-items: center; justify-content: flex-start; gap: 7px;
  padding: 9px 12px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--card-2);
  font-size: 14px; font-weight: 600; color: var(--text-2);
  cursor: pointer;
  transition: all .15s var(--ease);
}
.side-tab:hover { border-color: var(--accent-soft); }
.side-tab.active {
  background: var(--accent); border-color: var(--accent);
  color: #fff; box-shadow: 0 2px 8px rgba(0,113,227,0.28);
}
.tab-ic { display: inline-flex; flex: none; }
.tab-ic svg { width: 14px; height: 14px; }
.tab-label { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-tab .count { color: var(--text-3); font-size: 14px; font-variant-numeric: tabular-nums; flex: none; }
.side-tab.active .count { color: rgba(255,255,255,0.85); }
.side-tab.active .tab-ic { color: rgba(255,255,255,0.9); }

/* Lock button: an outlined chip so it's clearly visible & clickable by default */
.lock-btn {
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; width: 22px; height: 22px; border-radius: 6px;
  border: 1px solid var(--line);
  color: var(--text-2);
  transition: all .15s var(--ease);
}
.lock-btn svg { width: 14px; height: 14px; }
.side-tab:hover .lock-btn { color: var(--accent); border-color: var(--accent-soft); }
.lock-btn:hover { background: var(--accent-softer); border-color: var(--accent); color: var(--accent); }
.side-tab.active .lock-btn { color: rgba(255,255,255,0.9); border-color: rgba(255,255,255,0.45); }

/* Locked: prominent filled amber badge with a solid padlock */
.side-tab .lock-btn.on {
  color: #fff; background: #f59e0b; border-color: #f59e0b;
  box-shadow: 0 1px 5px rgba(245,158,11,0.5);
}
.side-tab .lock-btn.on svg { stroke-width: 2.2; }
.side-tab:hover .lock-btn.on { color: #fff; border-color: #f59e0b; }
.side-tab.active .lock-btn.on { color: #fff; background: #f59e0b; border-color: rgba(255,255,255,0.75); }

/* Locked tab: amber dashed border + amber tint — unmistakable */
.side-tab.locked { border: 1.5px dashed #f59e0b; background: rgba(245,158,11,0.10); }
.side-tab.locked:hover { border-color: #f59e0b; }

/* Active + locked: keep the active fill, mark locked with a white dashed edge */
.side-tab.active.locked { border: 1.5px dashed rgba(255,255,255,0.9); background: var(--accent); }
.stash-body { padding: 0; flex: 1; min-width: 0; }
.stash-meta {
  display: flex; align-items: center; gap: 22px;
  padding: 14px 18px; border-bottom: 1px solid var(--line-soft);
  background: var(--card-2);
}
.stash-stat { display: flex; align-items: center; gap: 9px; }
.stash-stat.grow { flex: 1; }
.stash-k { font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
.stash-v { font-size: 14px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.stash-preset { display: flex; align-items: center; gap: 12px; margin-right: auto; min-width: 0; }
.scan-bar { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.scan-chip {
  min-width: 26px; padding: 2px 5px;
  border-radius: 5px;
  background: var(--field-soft);
  border: 1px solid var(--line-soft);
  font-size: 10.5px; font-variant-numeric: tabular-nums;
  color: var(--text-3); text-align: center;
}
.scan-chip.hot { border-color: var(--accent); color: var(--accent); font-weight: 700; }

/* grid */
.grid-scroll {
  padding: 20px 18px 24px;
  overflow-x: auto;
  user-select: none;
  -webkit-user-select: none;
}
.stash-grid { position: relative; margin: 0 auto; }
.grid-bg { display: grid; gap: 2px; }
.bg-cell {
  background: var(--field-soft);
  border: 1px solid var(--line-soft);
  border-radius: 4px;
}
.equip-bg { position: absolute; inset: 0; pointer-events: none; }
.eq-slot {
  position: absolute;
  border: 1.5px dashed rgba(255,255,255,0.16);
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  box-sizing: border-box;
}
.cell-item {
  position: absolute; display: flex; align-items: flex-end;
  padding: 3px 5px;
  background: var(--rbg);
  border-radius: 5px;
  overflow: hidden; cursor: default;
  transition: transform .14s var(--ease), box-shadow .14s var(--ease);
}
.item-icon {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover; object-position: center;
  pointer-events: none;
}
.cell-item.hidden { display: none; }
.cell-item:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.2); z-index: 5; }

/* 上架点选：稀有度色细描边，轻发光 */
.cell-item.sell-picked {
  outline: 1px solid var(--rc);
  outline-offset: -1px;
  box-shadow: 0 0 4px var(--rc), inset 0 0 0 40px var(--rbg);
  z-index: 6;
}

/* 左键框选矩形 */
.sel-box {
  position: absolute;
  z-index: 8;
  border: 1.5px solid var(--accent);
  background: rgba(0, 113, 227, 0.15);
  pointer-events: none;
}
.cell-price {
  position: absolute; left: 0; right: 0; bottom: 2px;
  text-align: center;
  font-size: 12px; line-height: 1.2;
  color: #F4B400; font-weight: 800;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.7);
  pointer-events: none;
}
/* 历史查价价（未选中直接显示，略淡） */
.cell-price.hist { font-size: 11px; font-weight: 700; opacity: 0.85; }

/* ── 上架面板：Apple / Fluent 风格 ── */
.sell-panel {
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--line-soft);
  border-radius: 14px;
}
.sp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sp-title { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.sp-clear {
  font-size: 12px; color: var(--text-3);
  background: none; border: none; cursor: pointer; padding: 2px 4px;
  transition: color .15s var(--ease);
}
.sp-clear:hover { color: var(--red); }

/* 分段控件（segmented control） */
.sp-seg {
  display: flex; gap: 2px;
  background: var(--card-2);
  border-radius: 9px;
  padding: 3px;
  margin-bottom: 12px;
}
.sp-seg button {
  flex: 1; padding: 6px 0;
  font-size: 12.5px; font-weight: 600;
  color: var(--text-3);
  background: none; border: none; border-radius: 7px;
  cursor: pointer;
  transition: all .18s var(--ease);
}
.sp-seg button.on {
  background: var(--card); color: var(--text);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

/* 操作区 */
.sp-body { display: flex; flex-direction: column; gap: 9px; }
.sp-btn {
  padding: 9px 0;
  font-size: 13px; font-weight: 600;
  color: var(--text-2);
  background: var(--card-2);
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  cursor: pointer;
  transition: all .15s var(--ease);
}
.sp-btn:hover { filter: brightness(1.03); border-color: var(--accent-soft); }
.sp-btn:disabled { opacity: .45; cursor: default; }
.sp-btn.on { color: var(--green); background: var(--green-soft); border-color: var(--green-soft); }
.sp-btn.primary {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12);
}
.sp-btn.primary:hover { filter: brightness(1.08); border-color: var(--accent); }

/* 仓库弹选 */
.sp-picker {
  border: 1px solid var(--line-soft); border-radius: 9px;
  padding: 6px 8px; max-height: 140px; overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.sp-picker::-webkit-scrollbar { width: 5px; }
.sp-picker::-webkit-scrollbar-track { background: transparent; }
.sp-picker::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
.sp-picker::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
.sp-picker label {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 6px;
  font-size: 12.5px; color: var(--text-2);
  cursor: pointer; border-radius: 6px;
  transition: background .12s var(--ease);
}
.sp-picker label:hover { background: var(--card-2); }
.sp-picker label.on { color: var(--accent); font-weight: 600; }
.sp-picker label em { margin-left: auto; font-style: normal; color: var(--text-3); font-size: 11.5px; }
.sp-picker-empty { font-size: 12px; color: var(--text-3); padding: 6px; }

/* 进度条 */
.sp-progress {
  display: flex; align-items: center; gap: 9px;
  margin-top: 12px;
}
.sp-bar { flex: 1; height: 5px; background: var(--card-2); border-radius: 3px; overflow: hidden; }
.sp-bar-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .3s var(--ease); }
.sp-progress span { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.sp-progress button {
  font-size: 12px; color: var(--red);
  background: none; border: none; cursor: pointer;
}
.sp-progress button:hover { text-decoration: underline; }

/* 状态提示 */
.sp-note { margin-top: 10px; font-size: 12px; color: var(--green); line-height: 1.4; }
.sp-note.warn { color: var(--red); }

/* 右键显示 tooltip（固定鼠标位置，按钮在 tooltip 外） */
.tip-wrap {
  position: fixed;
  z-index: 180;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.tip-wrap.right { transform: translate (16px, 10px); }
.tip-wrap.left { transform: translate (-266px, 10px); }

html[data-theme="dark"] .bg-cell { background: rgba(255,255,255,0.03); }

/* debug preview */
.debug-btn {
  flex: none; margin-left: auto;
  padding: 4px 12px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--card-2); color: var(--text-2);
  cursor: pointer; transition: all .15s var(--ease);
}
.debug-btn:hover { border-color: var(--accent-soft); }
.debug-btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.debug-btn:disabled { opacity: .5; cursor: default; }
.preview-item {
  position: absolute;
  background: var(--rbg);
  border-radius: 5px;
  overflow: hidden;
  pointer-events: none; z-index: 10;
}
</style>
