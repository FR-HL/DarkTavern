<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import StashPane from './StashPane.vue';
import { refreshCapture } from '../composables/capture.js';

const props = defineProps ({
  charId: { type: String, default: '' },
  stashId: { type: String, default: '' },
  stackMode: { type: Boolean, default: false },
  includeInv: { type: Boolean, default: false },
  keepInPlace: { type: Boolean, default: true },
});
const emit = defineEmits ([ 'update:charId', 'update:stashId', 'update:equipment', 'update:active' ]);

const invoke = (ch, ...args) => window.electron.invoke (ch, ...args);

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
  connectEvents ();
  reportStashState ();
  applyFollowMode ();

  // 组件常驻（v-show）后不再随切换重建：启动时后端可能尚未就绪，
  // 后端就绪或角色列表为空时补刷新，避免"角色空但仓库在"的错位。
  window.electron.on ('ocr:status', (d) => {
    if (d?.ok && !characters.value.length) loadCharacters ();
  });
  retryTimer = setInterval (() => {
    if (!characters.value.length) loadCharacters ();
    else if (retryTimer) { clearInterval (retryTimer); retryTimer = null; }
  }, 5000);
});

onBeforeUnmount (() => {
  if (followTimer) { clearInterval (followTimer); followTimer = null; }
  if (retryTimer) { clearInterval (retryTimer); retryTimer = null; }
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
            {{ previewLoading ? '计算中…' : (debugPreview ? '关闭预览' : '排序预览') }}
          </button>
          <span v-if="debugPreview && previewSteps !== null" class="preview-steps">移动 {{ previewSteps }} 步</span>
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
.preview-steps {
  flex: none; margin-left: 8px;
  padding: 4px 10px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--accent-soft); border-radius: 6px;
  background: rgba(255, 140, 0, 0.12); color: var(--accent);
}
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
