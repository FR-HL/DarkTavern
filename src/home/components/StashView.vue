<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import StashPane from './StashPane.vue';

const props = defineProps ({
  charId: { type: String, default: '' },
  stashId: { type: String, default: '' },
});
const emit = defineEmits ([ 'update:charId', 'update:stashId', 'update:equipment', 'update:active' ]);

const invoke = (ch, d) => window.electron.invoke (ch, d);

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

watch (currentStash, (s) => emit ('update:equipment', !!(s && s.layout === 'equipment')), { immediate: true });

// 选择仓库：切换前端显示，并联动点击游戏内对应标签（背包/装备无游戏内标签）
function selectTab (s) {
  emit ('update:stashId', s.id);
  const id = parseInt (s.id) || 0;
  if (id === 2 || id === 3) return;
  invoke ('stash:switch-in-game', { stash_id: s.id, character_id: props.charId });
}

// ── 跟随游戏内切换（像素扫描高亮标签） ──
const followInGame = ref (false);
const scanBrights = ref ([]);
const scanLast = ref ('');
let followTimer = null;

function toggleFollow () {
  followInGame.value = !followInGame.value;
  if (followInGame.value) {
    if (followTimer) clearInterval (followTimer);
    followTimer = setInterval (pollInGameTab, 800);
    pollInGameTab ();
  } else if (followTimer) {
    clearInterval (followTimer);
    followTimer = null;
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

// ── 跟随校准（逐 Tab 记录选中态特征） ──
const calOpen = ref (false);
const calItems = ref ([]);
const calPending = ref ([]);
const calNote = ref ('');

async function loadFollowCal () {
  try {
    const r = await invoke ('stash:follow-calibrate-status');
    if (r && Array.isArray (r.mapping)) {
      calItems.value = r.mapping.map ((t, i) => ({
        type: t,
        label: (r.labels && r.labels[i]) || String (t),
        saved: r.saved && r.saved[i],
      }));
      calPending.value = (r.pending || []).slice ();
    }
  } catch (e) {}
}

async function recordFollowCal (index) {
  calNote.value = '';
  const r = await invoke ('stash:follow-calibrate-record', index);
  if (r && r.success) {
    const next = calPending.value.slice ();
    next[index] = { avg: r.avg, gold: r.gold };
    calPending.value = next;
  } else {
    calNote.value = '记录失败，请重试';
  }
}

async function saveFollowCal () {
  const r = await invoke ('stash:follow-calibrate-save');
  if (r && r.success) { calNote.value = '跟随校准已保存，自动切换到特征匹配'; await loadFollowCal (); }
  else if (r && Array.isArray (r.missing)) calNote.value = `还有 ${r.missing.length} 个标签未记录`;
  else calNote.value = '保存失败';
}

async function resetFollowCal () {
  calNote.value = '';
  await invoke ('stash:follow-calibrate-reset');
  await loadFollowCal ();
}

// ── 自动校准（一键） ──
const autoCalBusy = ref (false);

async function autoCalibrate () {
  if (autoCalBusy.value) return;
  autoCalBusy.value = true;
  calNote.value = '自动校准中：程序将依次点击游戏里的每个仓库标签并采样…请勿移动鼠标';
  try {
    const r = await invoke ('stash:follow-calibrate-auto');
    if (r && r.success) {
      calNote.value = '自动校准完成并已保存，跟随切换现在使用特征匹配';
      await loadFollowCal ();
    } else if (r) {
      const msg = r.error === 'uipi_blocked' ? '鼠标模拟被拦截（需管理员权限运行 DarkTavern）'
        : r.error === 'game_not_found' ? '未检测到游戏窗口，请先打开游戏仓库界面'
        : '自动校准失败：' + (r.error || '未知错误');
      calNote.value = msg;
    } else {
      calNote.value = '自动校准失败';
    }
  } catch (e) { calNote.value = '自动校准失败'; }
  autoCalBusy.value = false;
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
    id: 'test', label: '品质区分',
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
];

const sortPreset = ref ('default');

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
    if (g && g.mode === 'sized') { sortPreset.value = 'test'; return; }
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

async function togglePreview () {
  if (debugPreview.value) {
    debugPreview.value = false;
    previewItems.value = [];
    return;
  }
  if (!props.charId || !props.stashId) return;
  previewLoading.value = true;
  try {
    const r = await invoke ('dnd:sort-preview', { character_id: props.charId, stash_id: props.stashId });
    if (r && Array.isArray (r.items)) {
      previewItems.value = r.items;
      debugPreview.value = true;
    }
  } catch (e) {}
  previewLoading.value = false;
}

function previewStyle (it) {
  return {
    left: it.x * (CELL + GAP) + 'px',
    top: it.y * (CELL + GAP) + 'px',
    width: it.width * CELL + (it.width - 1) * GAP + 'px',
    height: it.height * CELL + (it.height - 1) * GAP + 'px',
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

async function loadCharData (id, silent = false) {
  if (!silent) { loading.value = true; error.value = ''; charData.value = null; }
  try {
    const d = await invoke ('dnd:character', id);
    if (d && !d.error) {
      charData.value = d;
      if (!stashList.value.some (s => s.id === props.stashId)) {
        const first = stashList.value[0];
        if (first) emit ('update:stashId', first.id);
      }
    } else if (!silent) {
      error.value = d?.error || '加载失败';
    }
  } catch (e) { if (!silent) error.value = '加载失败'; }
  if (!silent) loading.value = false;
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

async function loadCharacters () {
  try {
    const d = await invoke ('dnd:characters');
    characters.value = d?.characters || [];
    if (characters.value.length && !props.charId) emit ('update:charId', characters.value[0].id);
  } catch (e) {}
}

async function loadStashes () {
  if (!props.charId) { emit ('update:stashId', ''); return; }
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
  if (props.charId) {
    selected.value = props.charId;
    await loadCharData (props.charId);
  }
  loadSortOrder ();
  window.addEventListener ('dnd:characters-refresh', onCharactersRefresh);
  connectEvents ();
  reportStashState ();
});

onBeforeUnmount (() => {
  if (followTimer) { clearInterval (followTimer); followTimer = null; }
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
      <div class="empty-d">启动抓包后，在游戏中选择角色并打开仓库，数据会自动出现在这里。</div>
    </div>

    <!-- 仓库网格 -->
    <div v-if="charData && currentStash" class="sec">
      <div class="sec-label">{{ charData.nickname }} 的仓库</div>

      <div class="stash-layout">
        <div class="stash-side">
          <button v-for="s in stashList" :key="s.id" class="side-tab"
                  :class="{ active: props.stashId === s.id }" @click="selectTab(s)"
                  :title="`${s.items.length} 件物品`">
            <span class="tab-ic">
              <svg v-if="tabIconType(s.label) === 'chest'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/><circle cx="12" cy="15" r="1" fill="currentColor" stroke="none"/></svg>
              <svg v-else-if="tabIconType(s.label) === 'star'" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
            </span>
            <span class="tab-label">{{ s.label }}</span>
            <span class="count">{{ s.items.length }}</span>
          </button>
        </div>

        <div class="stash-body card">
        <div class="stash-meta">
          <div class="stash-preset">
            <span class="stash-k">排序方案</span>
            <div class="preset-group">
              <button v-for="o in SORT_PRESETS" :key="o.id"
                      class="preset-opt" :class="{ active: sortPreset === o.id }"
                      @click="changePreset(o.id)">
                {{ o.label }}
              </button>
            </div>
          </div>
          <label class="follow-switch" :class="{ on: followInGame }" @click="toggleFollow">
            <span class="follow-dot"></span>
            <span class="follow-txt">跟随游戏内切换</span>
          </label>
          <button class="follow-cal-btn" @click="calOpen = !calOpen; if (calOpen) loadFollowCal()">{{ calOpen ? '收起校准' : '跟随校准' }}</button>
          <div v-if="followInGame && scanBrights.length" class="scan-bar" :title="'命中仓库: ' + (scanLast || '无')">
            <span v-for="(b, i) in scanBrights" :key="i" class="scan-chip" :class="{ hot: b === Math.max(...scanBrights) }" :style="{ opacity: Math.max(0.25, Math.min(1, b / 200)) }">{{ b }}</span>
          </div>
          <button v-if="!isEquipment" class="debug-btn" :class="{ on: debugPreview }" :disabled="previewLoading" @click="togglePreview">
            {{ previewLoading ? '计算中…' : (debugPreview ? '关闭预览' : '排序预览') }}
          </button>
        </div>

        <div v-if="calOpen" class="cal-panel">
          <div class="cal-auto">
            <button class="btn primary" :disabled="autoCalBusy" @click="autoCalibrate">{{ autoCalBusy ? '自动校准中…' : '一键自动校准' }}</button>
            <span class="cal-auto-desc">程序自动依次点击游戏里的每个仓库标签并采样，约 8 秒完成。请先在游戏中打开仓库界面。</span>
          </div>
          <div class="cal-intro">备用手动校准：先在游戏中<b>选中该仓库标签</b>，再回来点「记录」。</div>
          <div v-for="(it, i) in calItems" :key="i" class="cal-row">
            <span class="cal-idx">{{ i + 1 }}</span>
            <span class="cal-name">{{ it.label }}</span>
            <span class="cal-pos">
              <template v-if="calPending[i]">待保存 ({{ calPending[i].avg }}, {{ calPending[i].gold }})</template>
              <template v-else-if="it.saved">已校准 ({{ it.saved.avg }}, {{ it.saved.gold }})</template>
              <template v-else>未记录</template>
            </span>
            <button class="keybind-btn cal-btn" @click="recordFollowCal(i)">记录</button>
          </div>
          <div class="cal-foot">
            <button class="btn primary" @click="saveFollowCal">保存校准</button>
            <button class="btn" @click="resetFollowCal">清除</button>
            <span v-if="calNote" class="cal-note">{{ calNote }}</span>
          </div>
        </div>

        <div class="grid-scroll">
          <div class="stash-grid"
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
                 :class="{ hidden: debugPreview }"
                 :style="itemStyle (it)"
                 :title="`${it.name} · ${it.rarity} · ${it.width}×${it.height}`">
              <img v-if="it.icon" class="item-icon" :src="iconUrl (it)" alt="" loading="lazy" />
            </div>
            <template v-if="debugPreview && previewItems.length">
              <div v-for="(pi, i) in previewItems" :key="'p'+i" class="preview-item"
                   :style="previewStyle (pi)">
                <span class="preview-label">{{ pi.name }}</span>
              </div>
            </template>
          </div>
        </div>
        </div>
      </div>
    </div>

    <div v-else-if="loading" class="empty-hint"><div class="empty-t">加载中…</div></div>
  </div>
</template>

<style scoped>
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

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
  flex: none; width: 150px;
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
.preset-group { display: flex; gap: 6px; flex-wrap: wrap; }
.preset-opt {
  padding: 5px 14px; font-size: 12.5px; font-weight: 600;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--card-2); color: var(--text-2);
  cursor: pointer; transition: all .15s;
}
.preset-opt:hover { border-color: var(--accent-soft); }
.preset-opt.active {
  background: var(--accent); border-color: var(--accent);
  color: #fff; box-shadow: 0 2px 8px rgba(0,113,227,0.28);
}
.follow-switch {
  display: inline-flex; align-items: center; gap: 8px;
  margin-left: auto;
  padding: 5px 12px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--card-2); color: var(--text-3);
  font-size: 12px; font-weight: 600;
  cursor: pointer; user-select: none;
  transition: all .15s;
}
.follow-switch:hover { border-color: var(--accent-soft); color: var(--text-2); }
.follow-switch .follow-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-3); transition: all .2s;
}
.follow-switch.on { border-color: var(--accent); color: var(--accent); }
.follow-switch.on .follow-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); animation: followPulse 1.6s var(--ease) infinite; }
@keyframes followPulse { 0%,100% { box-shadow: 0 0 0 3px var(--accent-soft); } 50% { box-shadow: 0 0 0 6px rgba(0,113,227,0.12); } }
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
.follow-cal-btn {
  flex: none;
  padding: 5px 12px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--card-2); color: var(--text-2);
  cursor: pointer; transition: all .15s;
}
.follow-cal-btn:hover { border-color: var(--accent-soft); color: var(--accent); }
.cal-panel {
  margin: 0 18px; padding: 12px 14px;
  background: var(--card-2);
  border: 1px solid var(--line-soft);
  border-top: none;
  border-radius: 0 0 10px 10px;
}
.cal-intro { font-size: 12.5px; color: var(--text-2); line-height: 1.6; margin-bottom: 10px; }
.cal-intro b { color: var(--text); font-weight: 650; }
.cal-auto { display: flex; align-items: center; gap: 12px; padding: 4px 2px 12px; border-bottom: 1px solid var(--line-soft); margin-bottom: 10px; }
.cal-auto-desc { font-size: 12.5px; color: var(--text-3); line-height: 1.55; }
.cal-row { display: flex; align-items: center; gap: 12px; padding: 7px 2px; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
.cal-row:last-of-type { border-bottom: none; }
.cal-idx {
  width: 22px; height: 22px; flex: none;
  display: grid; place-items: center;
  border-radius: 7px;
  background: var(--accent-soft); color: var(--accent);
  font-size: 12px; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.cal-name { font-weight: 600; color: var(--text); min-width: 100px; }
.cal-pos { flex: 1; font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.cal-btn { min-width: 0; padding: 5px 12px; font-size: 12px; flex: none; }
.cal-foot { display: flex; align-items: center; gap: 10px; padding: 10px 2px 2px; }
.cal-note { font-size: 12.5px; color: var(--green); }

/* grid */
.grid-scroll { padding: 20px 18px 24px; overflow-x: auto; }
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
  position: absolute; display: grid; place-items: center;
  background: rgba(255, 140, 0, 0.22);
  border: 1.5px dashed rgba(255, 140, 0, 0.7);
  border-radius: 4px; pointer-events: none; z-index: 10;
}
.preview-label {
  font-size: 10px; font-weight: 700; color: #ff8c00;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  line-height: 1.2; text-align: center;
  overflow: hidden; word-break: break-all;
  padding: 2px;
}
</style>
