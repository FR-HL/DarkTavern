<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { RARITY_CN, rarityColor } from '@/shared/lib/rarity.js';

import donorKk from '@assets/images/sponsors/donor_kk.webp';
import donorYueliang from '@assets/images/sponsors/yueliang.webp';
import donorWangjiajun from '@assets/images/sponsors/wangjiajun.webp';
import donorYuehai from '@assets/images/sponsors/yuehai.webp';
import donorLidand from '@assets/images/sponsors/lidang.webp';
import donorMobao from '@assets/images/sponsors/mobao.webp';
import adminAvatar from '@assets/images/admin.avif';

import StashView from './components/StashView.vue';
import SortControl from './components/SortControl.vue';
import PacketPane from './components/PacketPane.vue';

const invoke = (channel, data) => window.electron.invoke (channel, data);

const TABS = [
  { key: 'items', label: '物品' },
  { key: 'attributes', label: '属性' },
  { key: 'keywords', label: '关键词' },
  { key: 'custom', label: '自定义' },
];
const SRC = { items: '物品', attributes: '属性', keywords: '关键词', custom: '自定义' };

const pane = ref ('overview');
const ocrOk = ref (false);
const gameOk = ref (false);

const runes = reactive ({
  ocr: { state: 'pending', text: '唤醒中…', color: 'var(--ink-faint)' },
  game: { state: 'pending', text: '等待游戏…', color: 'var(--ink-faint)' },
  key: { state: 'ok', text: '已绑定', color: 'var(--gold)' },
  api: { state: 'pending', text: '检测中…', color: 'var(--ink-faint)' },
});

const mMappings = ref (0);
const uptime = ref ('00:00');
const verDotBad = ref (true);
const version = ref ('—');
const ocrState = ref ('');
const ocrStatusText = ref ('检查中…');
const ocrStatusColor = ref ('var(--ink-dim)');
const mappingCount = ref ('—');

// ── 概览 · 功能状态 ──
const overviewCapture = ref (false);
const overviewSorting = ref (false);
const overviewSortText = ref ('');
const sessionScans = ref (0);
const historyCount = ref (0);
const charCount = ref (0);
const stashItems = ref (0);
const sortHotkey = ref ('Ctrl+R');
const cancelHotkey = ref ('Ctrl+T');

const apiKey = ref ('');
const apiKeyVisible = ref (false);
const scanKey = ref ('XButton1');
const scanMode = ref ('manual');
const alignment = ref ('attached');
const scale = ref (1.0);
const launchOnStartup = ref (false);

const settingsStatus = reactive ({ type: '', text: '' });
const mappingStatus = reactive ({ type: '', text: '' });
const toastMsg = ref ('');
const toastShow = ref (false);

const isListening = ref (false);
const newKeybind = ref (null);

const ALIGNMENTS = [
  { key: 'attached', label: '贴附物品' },
  { key: 'top-left', label: '左上角' },
  { key: 'top-right', label: '右上角' },
  { key: 'bottom-left', label: '左下角' },
  { key: 'bottom-right', label: '右下角' },
];

const allMappings = reactive ({ items: {}, attributes: {}, keywords: {}, custom: {} });
const currentTab = ref ('items');
const search = ref ('');
const mappingsLoaded = ref (false);
const cnInput = ref ('');
const enInput = ref ('');

// ── 设置页 · 开发者工具 ──
const developerMode = ref (false);
const devCard = ref ('');
const theme = ref ('light');

function applyTheme () {
  document.documentElement.dataset.theme = theme.value === 'dark' ? 'dark' : 'light';
}

async function setTheme (t) {
  if (theme.value === t) return;
  theme.value = t;
  applyTheme ();
  const r = await invoke ('settings:save', { theme: t });
  if (!r?.success) {
    theme.value = t === 'dark' ? 'light' : 'dark';
    applyTheme ();
  }
}

// ── 仓库整理 · 共享状态 ──
const sortCharId = ref ('');
const sortStashId = ref ('');
const sortEquipment = ref (false);
const sortActiveCharId = ref ('');
const sortStack = ref (true);
const sortIncludeInv = ref (true);
const sortKeepInPlace = ref (true);

async function saveSortConfig () {
  try {
    await invoke ('dnd:sort-config-save', {
      character_id: sortCharId.value,
      stash_id: sortStashId.value,
      stack_mode: sortStack.value,
      include_inventory: sortIncludeInv.value,
      keep_in_place: sortKeepInPlace.value,
    });
  } catch (e) {}
}

async function restoreSortConfig () {
  try {
    const cfg = await invoke ('dnd:sort-config-get');
    if (!cfg) return;
    if (cfg.character_id) sortCharId.value = cfg.character_id;
    if (cfg.stash_id) sortStashId.value = cfg.stash_id;
    sortStack.value = !!cfg.stack_mode;
    sortIncludeInv.value = !!cfg.include_inventory;
    sortKeepInPlace.value = cfg.keep_in_place !== false;
  } catch (e) {}
}

watch ([sortCharId, sortStashId, sortStack, sortIncludeInv, sortKeepInPlace], saveSortConfig);

let lastMappings = -1;
let toastTimer = null;
let settingsTimer = null;
let mappingTimer = null;
let scaleTimer = null;
let uptimeTimer = null;
let overviewTimer = null;
const startMs = Date.now ();

const headline = computed (() => {
  if (!ocrOk.value) return '侍者正在备酒';
  if (overviewSorting.value) return '正在整理仓库…';
  if (!gameOk.value) return '酒馆已经开张';
  if (!overviewCapture.value) return '酒馆还未开张';
  return '万事俱备 · 悬停即知价';
});
const sub = computed (() => {
  if (!ocrOk.value) return 'OCR 引擎唤醒中，请稍候片刻…';
  if (overviewSorting.value) return '仓库整理进行中，请保持游戏窗口在前台';
  if (!gameOk.value) return '启动游戏、把鼠标悬停在物品上即可查价';
  if (!overviewCapture.value) return '启动抓包后，到角色选择界面选一次角色即可取得仓库数据';
  return '已检测到游戏窗口，按下 ' + scanKey.value + ' 开始';
});
const subHtml = computed (() => {
  const esc = (s) => String (s).replace (/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!ocrOk.value) return 'OCR 引擎唤醒中，请稍候片刻…';
  if (overviewSorting.value) return '仓库整理进行中，请保持游戏窗口在前台';
  if (!gameOk.value) return '启动游戏、把鼠标悬停在物品上即可查价';
  if (!overviewCapture.value) return '启动抓包后，到角色选择界面选一次角色即可取得仓库数据';
  return '已检测到游戏窗口，按下 <span class="kbd">' + esc (scanKey.value) + '</span> 即刻查价';
});
const scaleVal = computed (() => scale.value.toFixed (1) + '×');
const keybindLabel = computed (() => {
  if (isListening.value) return '等待输入…（按 Esc 取消）';
  return newKeybind.value || '点击此处，然后按下新按键';
});
const counts = computed (() => {
  const c = {};
  for (const t of TABS) c[t.key] = Object.keys (allMappings[t.key] || {}).length;
  return c;
});
const currentEntries = computed (() => {
  const data = allMappings[currentTab.value] || {};
  const q = search.value.toLowerCase ();
  const out = [];
  for (const [cn, en] of Object.entries (data)) {
    if (q && !cn.toLowerCase ().includes (q) && !en.toLowerCase ().includes (q)) continue;
    out.push ({ cn, en });
  }
  return out;
});

const donors = [
  { name: '娱乐陪-凯凯', amount: 888, avatar: donorKk },
  { name: '月亮汐', amount: 500, avatar: donorYueliang },
  { name: '王加钧', amount: 300, avatar: donorWangjiajun },
  { name: '犯罪升级', amount: 100, avatar: donorYuehai },
  { name: '李狗蛋', amount: 100, avatar: donorLidand },
  { name: '摸宝仙人', amount: 55, avatar: donorMobao },
  { name: '*建', amount: 150, avatar: null }, { name: '*路', amount: 200, avatar: null },
  { name: '*人', amount: 120, avatar: null }, { name: '朝代', amount: 116, avatar: null },
  { name: '**迪', amount: 100, avatar: null }, { name: 'J*y', amount: 100, avatar: null },
  { name: '*七', amount: 100, avatar: null }, { name: '*思', amount: 88, avatar: null },
  { name: '**天', amount: 80, avatar: null }, { name: 'Anxu安叙', amount: 66, avatar: null },
  { name: 'w*t', amount: 66, avatar: null }, { name: 'J*X', amount: 60, avatar: null },
  { name: '*洛', amount: 56.9, avatar: null }, { name: '生活', amount: 50, avatar: null },
  { name: '*终', amount: 50, avatar: null }, { name: '**旭', amount: 50, avatar: null },
  { name: '*票', amount: 50, avatar: null }, { name: '1*3', amount: 41, avatar: null },
  { name: 'D*n', amount: 30, avatar: null }, { name: '5*3', amount: 30, avatar: null },
  { name: 'L*s', amount: 30, avatar: null }, { name: '8*t', amount: 30, avatar: null },
  { name: '奥*n', amount: 30, avatar: null }, { name: '*灼', amount: 30, avatar: null },
  { name: '*.', amount: 30, avatar: null }, { name: '*尘', amount: 26.66, avatar: null },
  { name: 'R*H', amount: 25, avatar: null }, { name: '月下浊酒', amount: 20, avatar: null },
  { name: '*酒', amount: 20, avatar: null }, { name: '*手', amount: 20, avatar: null },
  { name: '*无', amount: 20, avatar: null }, { name: 'qwq', amount: 20, avatar: null },
  { name: '**成', amount: 20, avatar: null },
  { name: 'H*.', amount: 20, avatar: null }, { name: 'A*d', amount: 20, avatar: null },
  { name: '*令包', amount: 18.8, avatar: null }, { name: '**豪', amount: 16.67, avatar: null },
  { name: '*宇', amount: 15, avatar: null }, { name: '*阳', amount: 14, avatar: null },
  { name: '*仲', amount: 5, avatar: null }, { name: '**翔', amount: 5, avatar: null },
  { name: '*景', amount: 5, avatar: null }, { name: '*棒', amount: 5, avatar: null },
  { name: '*ア', amount: 5, avatar: null }, { name: '*叶', amount: 5, avatar: null },
  { name: 'K*7', amount: 5, avatar: null }, { name: '*果', amount: 5, avatar: null },
  { name: '*z', amount: 5, avatar: null }, { name: 'f*r', amount: 10, avatar: null },
  { name: '**赫', amount: 10, avatar: null }, { name: '*了', amount: 10, avatar: null },
  { name: '*灯', amount: 10, avatar: null }, { name: '*君', amount: 10, avatar: null },
  { name: 'S*o', amount: 10, avatar: null }, { name: '*风', amount: 10, avatar: null },
  { name: '*彭', amount: 10, avatar: null }, { name: '***', amount: 10, avatar: null },
  { name: '*垠', amount: 9.9, avatar: null }, { name: 'n*.', amount: 9.99, avatar: null },
  { name: '-*|', amount: 9, avatar: null }, { name: 'U*S', amount: 6.66, avatar: null },
  { name: '*名', amount: 6.66, avatar: null }, { name: '*舟', amount: 6, avatar: null },
  { name: 'Shameless', amount: 5.2, avatar: null }, { name: '*棉', amount: 5.2, avatar: null },
  { name: '**涵', amount: 3, avatar: null }, { name: '*界', amount: 3, avatar: null },
  { name: '*同', amount: 1, avatar: null }, { name: 'S*z', amount: 1, avatar: null },
  { name: '*号', amount: 1, avatar: null }, { name: '**硕', amount: 1, avatar: null },
  { name: '*明', amount: 0.27, avatar: null }, { name: '*语', amount: 0.01, avatar: null },
  { name: '*光盘', amount: 1.7, avatar: null }, { name: '*潮', amount: 0.99, avatar: null },
];

const sortedDonors = computed (() => [...donors].sort ((a, b) => b.amount - a.amount));

const topDonors = computed (() => {
  const top3 = sortedDonors.value.slice (0, 3);
  const reordered = [null, null, null];
  if (top3[0]) reordered[1] = top3[0];
  if (top3[1]) reordered[0] = top3[1];
  if (top3[2]) reordered[2] = top3[2];
  return reordered.filter (Boolean);
});

const remainingDonors = computed (() => sortedDonors.value.slice (3));

function hallRank (index) {
  if (index === 1) return 1;
  if (index === 0) return 2;
  return 3;
}

function donorInitial (name) {
  if (!name) return '?';
  const clean = name.replace (/\*/g, '').trim ();
  return clean.charAt (0).toUpperCase () || '?';
}

function showPane (name) {
  pane.value = name;
  if (name === 'history') loadHistory ();
}

// ── 查价记录 ──

const historyRecords = ref ([]);
const expandedHistory = ref (null);

async function loadHistory () {
  try {
    const r = await invoke ('history:list');
    historyRecords.value = r?.records || [];
  } catch (e) { /* ignore */ }
}

async function clearHistory () {
  if (!confirm ('确定清空全部查价记录吗？')) return;
  try {
    await invoke ('history:clear');
    historyRecords.value = [];
    showToast ('已清空');
  } catch (e) { /* ignore */ }
}

function fmtHistoryTime (ts) {
  const d = new Date (ts);
  const pad = (x) => String (x).padStart (2, '0');
  return `${pad (d.getMonth () + 1)}-${pad (d.getDate ())} ${pad (d.getHours ())}:${pad (d.getMinutes ())}`;
}

function fmtG (v) {
  if (v == null) return '—';
  return Number (v).toLocaleString () + ' G';
}

function toggleHistoryRow (idx) {
  const rec = historyRecords.value[idx];
  if (!rec) return;
  expandedHistory.value = expandedHistory.value === rec.ts ? null : rec.ts;
}

function attrZh (rec, display) {
  const zh = rec.reverseAttributes?.[display];
  return zh || display;
}

function attrVal (a) {
  if (a.min != null) return `${a.min} - ${a.max}`;
  if (a.value != null) return a.value;
  return '';
}

const gradeCls = (g) => {
  const map = { S: 'gS', A: 'gA', B: 'gB', C: 'gC', D: 'gD', F: 'gF' };
  return map[g] || 'gN';
};

function showToast (msg) {
  toastMsg.value = msg;
  toastShow.value = true;
  clearTimeout (toastTimer);
  toastTimer = setTimeout (() => { toastShow.value = false; }, 1600);
}
function showSettingsStatus (msg, type) {
  settingsStatus.type = type; settingsStatus.text = msg;
  clearTimeout (settingsTimer);
  settingsTimer = setTimeout (() => { settingsStatus.type = ''; settingsStatus.text = ''; }, 4000);
}
function showMappingStatus (msg, type) {
  mappingStatus.type = type; mappingStatus.text = msg;
  clearTimeout (mappingTimer);
  mappingTimer = setTimeout (() => { mappingStatus.type = ''; mappingStatus.text = ''; }, 3000);
}

function copyGroup () { window.electron.clipboardWriteText ('237874334'); showToast ('群号已复制'); }
function copyWechat () { window.electron.clipboardWriteText ('ZFZ13434'); showToast ('商务微信已复制'); }
function openGithub () { window.electron.openExternal ('https://github.com/FR-HL/DarkTavern'); }
function openLink (url) { window.electron.openExternal (url); }

function setRune (key, state, text, color) { runes[key] = { state, text, color }; }

function animateNumber (from, to, dur) {
  const t0 = performance.now ();
  (function step (t) {
    const p = Math.min (1, (t - t0) / dur);
    const e = 1 - Math.pow (1 - p, 3);
    mMappings.value = Math.round (from + (to - from) * e);
    if (p < 1) requestAnimationFrame (step);
  }) (t0);
}
function setMappings (n) {
  if (n === lastMappings) return;
  animateNumber (lastMappings < 0 ? 0 : lastMappings, n, 700);
  lastMappings = n;
}

function tick () {
  const s = Math.floor ((Date.now () - startMs) / 1000);
  const h = Math.floor (s / 3600), m = Math.floor ((s % 3600) / 60), ss = s % 60;
  const pad = (x) => String (x).padStart (2, '0');
  uptime.value = h > 0 ? `${h}:${pad (m)}:${pad (ss)}` : `${pad (m)}:${pad (ss)}`;
}

async function refreshOverview () {
  try {
    const s = await invoke ('ball:get-status');
    if (s) {
      overviewCapture.value = !!s.captureRunning;
      overviewSorting.value = !!s.sortingRunning;
      overviewSortText.value = s.lastSortText || '';
      sessionScans.value = s.sessionScans || 0;
    }
  } catch (e) {}
  try {
    const d = await invoke ('settings:get');
    if (d?.sort_hotkey) sortHotkey.value = d.sort_hotkey;
    if (d?.cancel_hotkey) cancelHotkey.value = d.cancel_hotkey;
  } catch (e) {}
  try {
    const h = await invoke ('history:list');
    if (h?.records) historyCount.value = h.records.length;
  } catch (e) {}
  try {
    const c = await invoke ('dnd:characters');
    if (c?.characters) {
      charCount.value = c.characters.length;
      stashItems.value = c.characters.reduce ((n, x) => n + (x.total_items || 0), 0);
    }
  } catch (e) {}
}

async function fetchHealth () {
  try {
    const d = await invoke ('backend:health');
    if (d && d.status === 'ok') {
      ocrOk.value = true;
      setRune ('ocr', 'ok', '已就绪', 'var(--gold)');
      setMappings (d.mappings || 0);
      version.value = d.version || '—';
      verDotBad.value = false;
      ocrState.value = 'ok';
      ocrStatusText.value = '运行中';
      ocrStatusColor.value = 'var(--teal)';
      mappingCount.value = (d.mappings || 0) + ' 条';
      if (!mappingsLoaded.value) { mappingsLoaded.value = true; loadMappings (); }
    } else {
      ocrOk.value = false;
      setRune ('ocr', 'pending', '唤醒中…', 'var(--ink-faint)');
    }
  } catch (e) {
    ocrOk.value = false;
    setRune ('ocr', 'pending', '唤醒中…', 'var(--ink-faint)');
    verDotBad.value = true;
    ocrState.value = 'bad';
    ocrStatusText.value = '未运行';
    ocrStatusColor.value = 'var(--danger)';
  }
}

function onOcrStatus (data) {
  if (data.ok && !ocrOk.value) fetchHealth ();
  else if (!data.ok) {
    ocrOk.value = false;
    setRune ('ocr', 'pending', '唤醒中…', 'var(--ink-faint)');
    verDotBad.value = true;
    ocrState.value = 'bad';
    ocrStatusText.value = '未运行';
    ocrStatusColor.value = 'var(--danger)';
  }
}

function onGameStatus (data) {
  if (data.found) { gameOk.value = true; setRune ('game', 'ok', '已检测到', 'var(--teal)'); }
  else { gameOk.value = false; setRune ('game', 'pending', '等待游戏…', 'var(--ink-faint)'); }
}

async function fetchGameState () {
  try {
    const d = await invoke ('backend:window');
    onGameStatus ({ found: !!(d && d.found) });
  } catch (e) {
    onGameStatus ({ found: false });
  }
}

async function loadSettings () {
  try {
    const d = await invoke ('settings:get');
    apiKey.value = d.api_key || '';
    scanKey.value = d.scan_key || 'XButton1';
    scanMode.value = d.default_mode || 'manual';
    alignment.value = d.alignment || 'attached';
    scale.value = d.scale || 1.0;
    launchOnStartup.value = !!d.launch_on_startup;
    developerMode.value = !!d.developer_mode;
    theme.value = d.theme === 'dark' ? 'dark' : 'light';
    applyTheme ();
    setRune ('key', 'ok', '已绑定', 'var(--gold)');
    if (d.api_key) setRune ('api', 'ok', '已配置', 'var(--teal)');
    else setRune ('api', 'pending', '未配置', 'var(--ink-faint)');
  } catch (e) { /* ignore */ }
}

async function saveApiKey () {
  const r = await invoke ('settings:save', { api_key: apiKey.value });
  if (r.success) {
    showToast ('已保存');
    if (apiKey.value) setRune ('api', 'ok', '已配置', 'var(--teal)');
    else setRune ('api', 'pending', '未配置', 'var(--ink-faint)');
  }
}
function toggleApiKeyVisibility () { apiKeyVisible.value = !apiKeyVisible.value; }
async function saveLaunch () { const r = await invoke ('settings:save', { launch_on_startup: launchOnStartup.value }); if (r.success) showToast ('已保存'); }

async function toggleDeveloperMode () {
  developerMode.value = !developerMode.value;
  if (!developerMode.value) devCard.value = '';
  const r = await invoke ('settings:save', { developer_mode: developerMode.value });
  if (r.success) showToast (developerMode.value ? '开发者工具已开启' : '开发者工具已关闭');
  else developerMode.value = !developerMode.value;
}

function toggleDevCard (name) {
  devCard.value = devCard.value === name ? '' : name;
  if (devCard.value === 'mapping' && !mappingsLoaded.value) loadMappings ();
}

function startListening () { isListening.value = true; newKeybind.value = null; }
function stopListening () { isListening.value = false; }
function onKeyDown (e) {
  if (!isListening.value) return;
  e.preventDefault ();
  if (e.key === 'Escape') { stopListening (); return; }
  if (['F5', 'F6', 'F7', 'F8'].includes (e.key)) { showSettingsStatus ('F5–F8 为系统保留键，请另选', 'error'); return; }
  let key = '';
  if (e.ctrlKey) key += 'Ctrl+';
  if (e.altKey) key += 'Alt+';
  if (e.shiftKey) key += 'Shift+';
  if (e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Shift') {
    key += e.key.length === 1 ? e.key.toUpperCase () : e.key;
    newKeybind.value = key;
    stopListening ();
  }
}
function onMouseDown (e) {
  if (!isListening.value) return;
  e.preventDefault ();
  const names = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight', 3: 'XButton1', 4: 'XButton2' };
  const name = names[e.button];
  if (!name) return;
  newKeybind.value = name;
  stopListening ();
}
async function saveKeybind () {
  if (!newKeybind.value) { showSettingsStatus ('请先点击按钮并按下新按键', 'error'); return; }
  const r = await invoke ('settings:save', { scan_key: newKeybind.value });
  if (r.success) { scanKey.value = newKeybind.value; showToast ('已保存'); }
}
async function saveMode () { const r = await invoke ('settings:save', { default_mode: scanMode.value }); if (r.success) showToast ('已保存'); }
async function saveAlignment () { const r = await invoke ('settings:save', { alignment: alignment.value }); if (r.success) showToast ('已保存 · 下次扫描生效'); }
function setMode (m) { scanMode.value = m; saveMode (); }
function setAlignment (a) { alignment.value = a; saveAlignment (); }
function onScaleInput (e) {
  scale.value = parseFloat (e.target.value);
  clearTimeout (scaleTimer);
  scaleTimer = setTimeout (saveScale, 200);
}
async function saveScale () { const r = await invoke ('settings:save', { scale: scale.value }); if (r.success) showToast ('已保存'); }

async function loadMappings () {
  try {
    const r = await invoke ('chinese:mappings');
    Object.assign (allMappings, r);
  } catch (e) { /* OCR not ready */ }
}
function switchTab (tab) { currentTab.value = tab; }

async function addMapping () {
  const cn = cnInput.value.trim (), en = enInput.value.trim ();
  if (!cn || !en) { showMappingStatus ('请填写中文和英文', 'error'); return; }
  try {
    await invoke ('chinese:add-mapping', { chinese: cn, english: en });
    cnInput.value = ''; enInput.value = '';
    showMappingStatus ('已添加：' + cn + ' → ' + en, 'success');
    await loadMappings ();
  } catch (e) { showMappingStatus ('添加失败：' + e.message, 'error'); }
}
async function removeMapping (idx) {
  const entry = currentEntries.value[idx];
  if (!entry) return;
  if (!confirm ('确定删除 "' + entry.cn + '" 吗？')) return;
  try {
    await invoke ('chinese:remove-mapping', { chinese: entry.cn });
    showToast ('已删除');
    await loadMappings ();
  } catch (e) { showMappingStatus ('删除失败：' + e.message, 'error'); }
}

onMounted (() => {
  window.electron.on ('navigate', (p) => {
    if (!p) return;
    if (typeof p === 'object') {
      showPane (p.pane || 'config');
      if (p.devCard) devCard.value = p.devCard;
      if (p.pane === 'config' && p.devCard === 'mapping' && !mappingsLoaded.value) loadMappings ();
    } else {
      showPane (p);
    }
  });
  window.electron.on ('ocr:status', onOcrStatus);
  window.electron.on ('game:status', onGameStatus);
  window.electron.on ('dnd:sort-notify', (d) => {
    if (d?.message) showToast (d.message);
  });
  window.electron.on ('stash:notify', (d) => {
    if (d?.message) showToast (d.message);
  });
  window.electron.on ('history:updated', () => {
    if (pane.value === 'history') loadHistory ();
  });
  window.electron.on ('stash:switch-to', (d) => {
    if (!d?.stash_id) return;
    sortStashId.value = String (d.stash_id);
    invoke ('stash:set-current', { id: String (d.stash_id), label: d.label || '' });
  });
  document.addEventListener ('keydown', onKeyDown);
  document.addEventListener ('mousedown', onMouseDown);
  uptimeTimer = setInterval (tick, 1000);
  overviewTimer = setInterval (refreshOverview, 5000);
  fetchHealth ();
  fetchGameState ();
  loadSettings ();
  restoreSortConfig ();
  refreshOverview ();
});

onBeforeUnmount (() => {
  document.removeEventListener ('keydown', onKeyDown);
  document.removeEventListener ('mousedown', onMouseDown);
  clearInterval (uptimeTimer);
  clearInterval (overviewTimer);
});
</script>

<template>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <svg class="brand-icon" viewBox="0 0 576 512" fill="currentColor"><path d="M0 80l0 48c0 17.7 14.3 32 32 32l16 0 48 0 0-80c0-26.5-21.5-48-48-48S0 53.5 0 80zM112 32c10 13.4 16 30 16 48l0 304c0 35.3 28.7 64 64 64s64-28.7 64-64l0-5.3c0-32.4 26.3-58.7 58.7-58.7L480 320l0-192c0-53-43-96-96-96L112 32zM464 480c61.9 0 112-50.1 112-112c0-8.8-7.2-16-16-16l-245.3 0c-14.7 0-26.7 11.9-26.7 26.7l0 5.3c0 53-43 96-96 96l176 0 96 0z"/></svg>
        <span class="brand-name"><span class="brand-grad">冒险者</span>酒馆</span>
      </div>

      <nav class="nav">
        <div class="nav-cap">导航</div>
        <div class="nav-item" :class="{ active: pane === 'overview' }" @click="showPane('overview')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
          概览
        </div>
        <div class="nav-item" :class="{ active: pane === 'guide' }" @click="showPane('guide')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          使用教程
        </div>
        <div class="nav-cap">查价工具</div>
        <div class="nav-item" :class="{ active: pane === 'settings' }" @click="showPane('settings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
          查价器
        </div>
        <div class="nav-item" :class="{ active: pane === 'history' }" @click="showPane('history')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
          查价记录
        </div>
        <div class="nav-cap">仓库整理</div>
        <div class="nav-item" :class="{ active: pane === 'stash' }" @click="showPane('stash')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
          角色仓库
        </div>
        <div class="nav-item" :class="{ active: pane === 'sort' }" @click="showPane('sort')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 9 6"/><polyline points="3 12 15 12"/><polyline points="3 18 21 18"/></svg>
          仓库配置
        </div>
        <div class="nav-cap">更多</div>
        <div class="nav-item" :class="{ active: pane === 'config' }" @click="showPane('config')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          设置
        </div>
        <div class="nav-item" :class="{ active: pane === 'about' }" @click="showPane('about')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.5" r="0.5" fill="currentColor" stroke="none"/></svg>
          关于酒馆
        </div>
        <div class="nav-item" :class="{ active: pane === 'sponsor' }" @click="showPane('sponsor')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          赞助酒馆
        </div>
        <div class="nav-item" :class="{ active: pane === 'disclaimer' }" @click="showPane('disclaimer')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          免责声明
        </div>
      </nav>

      <div class="side-foot">
        <div class="foot-safe">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>
          <span>仅读屏 · 不注入 · 不修改</span>
        </div>
        <div class="foot-row" title="点击复制群号" @click="copyGroup">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span class="foot-k">交流群</span>
          <span class="foot-v">237874334</span>
        </div>
        <a class="foot-row" href="#" @click.prevent="openGithub">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
          <span class="foot-k">开源</span>
          <span class="foot-v">GitHub</span>
        </a>
      </div>
    </aside>

    <div class="content">
      <!-- ============ 概览 ============ -->
      <div class="pane" :class="{ active: pane === 'overview' }">
        <div class="page-title">概览</div>
        <div class="page-sub">DarkTavern 运行状态一览。</div>

        <div class="hero">
          <div class="hero-ey"><span class="hero-dot" :class="{ warn: !gameOk || !ocrOk }"></span>实时状态</div>
          <div class="hero-title">{{ headline }}</div>
          <div class="hero-sub" v-html="subHtml"></div>
          <div class="hero-stats">
            <div class="hstat">
              <div class="hstat-k">查价 · 会话</div>
              <div class="hstat-v accent">{{ sessionScans.toLocaleString() }} <span class="hstat-unit">次</span></div>
            </div>
            <div class="hstat">
              <div class="hstat-k">查价 · 3 天</div>
              <div class="hstat-v">{{ historyCount.toLocaleString() }} <span class="hstat-unit">条</span></div>
            </div>
            <div class="hstat">
              <div class="hstat-k">角色</div>
              <div class="hstat-v">{{ charCount.toLocaleString() }} <span class="hstat-unit">个</span></div>
            </div>
            <div class="hstat">
              <div class="hstat-k">仓库物品</div>
              <div class="hstat-v">{{ stashItems.toLocaleString() }} <span class="hstat-unit">件</span></div>
            </div>
            <div class="hstat">
              <div class="hstat-k">本次会话</div>
              <div class="hstat-v">{{ uptime }}</div>
            </div>
          </div>
        </div>

        <div class="ov-grid">
          <section class="card">
            <div class="card-head"><span class="card-title">查价状态</span></div>
            <div class="stat-row"><span class="sdot" :class="runes.ocr.state"></span><span class="stat-k">OCR 引擎</span><span class="stat-v" :class="runes.ocr.state">{{ runes.ocr.text }}</span></div>
            <div class="stat-row"><span class="sdot" :class="runes.game.state"></span><span class="stat-k">游戏窗口</span><span class="stat-v" :class="runes.game.state">{{ runes.game.text }}</span></div>
            <div class="stat-row"><span class="sdot" :class="runes.key.state"></span><span class="stat-k">扫描热键</span><span class="stat-v" :class="runes.key.state">{{ runes.key.text }}</span></div>
            <div class="card-foot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>不读取游戏内存 · 仅屏幕识别<span class="foot-ver">v{{ version }}</span></div>
          </section>

          <section class="card">
            <div class="card-head"><span class="card-title">仓库工具状态</span></div>
            <div class="stat-row"><span class="sdot" :class="overviewCapture ? 'ok' : 'pending'"></span><span class="stat-k">抓包</span><span class="stat-v" :class="overviewCapture ? 'ok' : 'pending'">{{ overviewCapture ? '运行中' : '已停止' }}</span></div>
            <div class="stat-row"><span class="sdot" :class="overviewSorting ? 'ok' : 'pending'"></span><span class="stat-k">仓库整理</span><span class="stat-v" :class="overviewSorting ? 'ok' : 'pending'">{{ overviewSorting ? '进行中' : (overviewSortText || '空闲') }}</span></div>
            <div class="stat-row"><span class="sdot ok"></span><span class="stat-k">整理快捷键</span><span class="stat-v mono">{{ sortHotkey }} · {{ cancelHotkey }}</span></div>
            <div class="card-foot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 9 6"/><polyline points="3 12 15 12"/><polyline points="3 18 21 18"/></svg>抓包 → 角色仓库 → 一键整理</div>
          </section>

          <section class="card wide">
            <div class="card-head"><span class="card-title">上手引导</span></div>
            <div class="steps two-col">
              <div class="step-col">
                <div class="step-col-t">查价</div>
                <div class="step"><div class="step-n">1</div><div class="step-t">启动 <b>Dark and Darker</b>（中文客户端）</div></div>
                <div class="step"><div class="step-n">2</div><div class="step-t">把鼠标 <b>悬停</b> 在任意物品上</div></div>
                <div class="step"><div class="step-n">3</div><div class="step-t">按下 <span class="kbd">{{ scanKey }}</span> 即刻查价</div></div>
              </div>
              <div class="step-col">
                <div class="step-col-t">整理仓库</div>
                <div class="step"><div class="step-n">1</div><div class="step-t">启动<b>抓包</b>（角色仓库页）</div></div>
                <div class="step"><div class="step-n">2</div><div class="step-t">游戏<b>角色选择界面</b>选一次角色（取仓库数据）</div></div>
                <div class="step"><div class="step-n">3</div><div class="step-t">游戏中<b>打开要整理的仓库</b>界面</div></div>
                <div class="step"><div class="step-n">4</div><div class="step-t">按下 <span class="kbd">{{ sortHotkey }}</span> 开始整理</div></div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- ============ 查价器 ============ -->
      <div class="pane" :class="{ active: pane === 'settings' }">
        <div class="page-title">查价器</div>
        <div class="page-sub">账号凭证、扫描触发与悬浮窗外观。</div>

        <div class="sec">
          <div class="sec-label">账号凭证</div>
          <div class="card">
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">DarkerDB API Key</div>
                <div class="srow-d">在 darkerdb.com 注册获取 · 填入后查价更快、数据更完整</div>
              </div>
              <div class="srow-ctl key-ctl">
                <div class="key-field">
                  <svg class="field-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>
                  <input :type="apiKeyVisible ? 'text' : 'password'" v-model="apiKey" placeholder="输入你的 API Key">
                  <button class="eye-btn" type="button" @click="toggleApiKeyVisibility">{{ apiKeyVisible ? '隐藏' : '显示' }}</button>
                </div>
                <button class="btn primary" @click="saveApiKey">保存</button>
              </div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">扫描</div>
          <div class="card">
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">触发键</div>
                <div class="srow-d">支持键盘键（F1–F12、Ctrl 组合键）与鼠标侧键</div>
              </div>
              <div class="srow-ctl">
                <span class="kbd">{{ scanKey }}</span>
                <button class="keybind-btn" :class="{ listening: isListening }" @click="startListening">{{ keybindLabel }}</button>
                <button class="btn primary" @click="saveKeybind">保存</button>
              </div>
            </div>
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">扫描模式</div>
                <div class="srow-d">手动需悬停后按键，自动则悬停即查</div>
              </div>
              <div class="srow-ctl">
                <div class="seg">
                  <button class="seg-opt" :class="{ on: scanMode === 'manual' }" @click="setMode('manual')">
                    <span class="seg-t">手动</span><span class="seg-d">按键触发</span>
                  </button>
                  <button class="seg-opt" :class="{ on: scanMode === 'automatic' }" @click="setMode('automatic')">
                    <span class="seg-t">自动</span><span class="seg-d">悬停触发</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">悬浮窗</div>
          <div class="card">
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">弹出位置</div>
                <div class="srow-d">更改后于下一次扫描生效</div>
              </div>
              <div class="srow-ctl">
                <div class="align-strip">
                  <button v-for="a in ALIGNMENTS" :key="a.key" class="align-opt" :class="{ on: alignment === a.key }" :title="a.label" @click="setAlignment(a.key)">
                    <span class="align-mini"><span class="align-dot" :data-pos="a.key"></span></span>
                    <span class="align-label">{{ a.label }}</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">缩放</div>
                <div class="srow-d">调整悬浮窗整体大小（0.6× – 2.0×）</div>
              </div>
              <div class="srow-ctl">
                <div class="scale-ctl">
                  <input type="range" min="0.6" max="2" step="0.1" :value="scale" @input="onScaleInput">
                  <span class="range-val">{{ scaleVal }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="status" :class="settingsStatus.type">{{ settingsStatus.text }}</div>
      </div>

      <!-- ============ 查价记录 ============ -->
      <div class="pane" :class="{ active: pane === 'history' }">
        <div class="page-title">查价记录</div>
        <div class="page-sub">最近 3 天内查询过的物品，自动保存；每次查价的价格数据完整记录。</div>

        <div class="map-toolbar">
          <div class="hist-count" v-if="historyRecords.length">共 <b>{{ historyRecords.length }}</b> 条记录</div>
          <div class="map-toolbar-spacer"></div>
          <button class="btn subtle sm" @click="loadHistory">刷新</button>
          <button class="btn danger sm" @click="clearHistory">清空记录</button>
        </div>

        <div class="table-wrap" v-if="historyRecords.length"><div class="table-scroll">
          <table>
            <thead><tr>
              <th style="width:104px">时间</th>
              <th style="width:34%">物品</th>
              <th style="width:88px">稀有度</th>
              <th style="width:104px">市场现价</th>
              <th style="width:104px">市场均价</th>
              <th style="width:104px">商人回收</th>
            </tr></thead>
            <tbody>
              <template v-for="(rec, idx) in historyRecords" :key="rec.ts + '-' + idx">
                <tr class="hist-row" :class="{ open: expandedHistory === rec.ts }" @click="toggleHistoryRow(idx)">
                  <td class="hist-time mono dim">{{ fmtHistoryTime (rec.ts) }}</td>
                  <td>
                    <div class="hist-item">
                      <span class="hist-zh" :style="{ color: rarityColor (rec.rarity) }">{{ rec.zhName || rec.name || '—' }}</span>
                      <span class="hist-en" v-if="rec.zhName && rec.name && rec.zhName !== rec.name">{{ rec.name }}</span>
                    </div>
                  </td>
                  <td><span class="hist-rarity" :style="{ color: rarityColor (rec.rarity) }">●</span> <span class="hist-rarity-name">{{ RARITY_CN[rec.rarity] || rec.rarity }}</span></td>
                  <td class="hist-price">{{ fmtG (rec.price) }}</td>
                  <td class="hist-price">{{ fmtG (rec.market) }}</td>
                  <td class="hist-price">{{ fmtG (rec.vendor) }}</td>
                </tr>
                <tr v-if="expandedHistory === rec.ts" class="hist-detail-row">
                  <td colspan="6">
                    <div class="hist-detail">
                      <div v-if="rec.attributes?.primary?.length" class="attr-group">
                        <div class="attr-group-title">主属性</div>
                        <div class="attr-list">
                          <span v-for="(a, i) in rec.attributes.primary" :key="'p'+i" class="attr-chip">{{ attrZh (rec, a.display) }}：{{ attrVal (a) }}</span>
                        </div>
                      </div>
                      <div v-if="rec.attributes?.secondary?.length" class="attr-group">
                        <div class="attr-group-title">副属性</div>
                        <div class="attr-list">
                          <span v-for="(a, i) in rec.attributes.secondary" :key="'s'+i" class="attr-chip">
                            {{ attrZh (rec, a.display) }}：{{ attrVal (a) }}<em v-if="a.grade" class="attr-grade" :class="gradeCls (a.grade)">{{ a.grade }}</em>
                          </span>
                        </div>
                      </div>
                      <div v-if="!rec.attributes?.primary?.length && !rec.attributes?.secondary?.length" class="attr-empty">无属性数据</div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div></div>

        <div v-else class="empty-hint">
          <div class="empty-t">暂无查价记录</div>
          <div class="empty-d">在游戏中悬停物品并按下扫描键，记录会自动出现在这里。</div>
        </div>
      </div>

      <!-- ============ 设置 ============ -->
      <div class="pane" :class="{ active: pane === 'config' }">
        <div class="page-title">设置</div>
        <div class="page-sub">通用选项与开发者工具。</div>

        <div class="sec">
          <div class="sec-label">通用</div>
          <div class="card">
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">外观</div>
                <div class="srow-d">切换白天 / 黑夜模式</div>
              </div>
              <div class="srow-ctl">
                <div class="seg">
                  <button class="seg-opt" :class="{ on: theme === 'light' }" @click="setTheme('light')">
                    <span class="seg-t">白天</span>
                  </button>
                  <button class="seg-opt" :class="{ on: theme === 'dark' }" @click="setTheme('dark')">
                    <span class="seg-t">黑夜</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="srow">
              <div class="srow-info">
                <div class="srow-t">开发者工具</div>
                <div class="srow-d">显示数据汉化、数据包等开发者功能卡片</div>
              </div>
              <div class="srow-ctl">
                <label class="switch"><input type="checkbox" :checked="developerMode" @change="toggleDeveloperMode"><span class="track"></span></label>
              </div>
            </div>
          </div>
        </div>

        <template v-if="developerMode">
          <div class="sec">
            <div class="dev-card-head" :class="{ open: devCard === 'mapping' }" @click="toggleDevCard('mapping')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>
              <div class="srow-info">
                <div class="srow-t">数据汉化</div>
                <div class="srow-d">中文 ↔ 英文翻译映射，由 DarkerDB API 同步生成，自定义条目可手动维护</div>
              </div>
              <svg class="dev-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div v-if="devCard === 'mapping'" class="dev-card-body">
              <div class="add-form" v-if="currentTab === 'custom'">
                <input type="text" v-model="cnInput" placeholder="中文（如：长剑）">
                <input type="text" v-model="enInput" placeholder="英文（如：Longsword）">
                <button class="btn primary" @click="addMapping">添加</button>
              </div>
              <div class="status" :class="mappingStatus.type">{{ mappingStatus.text }}</div>

              <div class="map-toolbar">
                <div class="search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
                  <input type="text" v-model="search" placeholder="搜索汉化数据…">
                </div>
              </div>

              <div class="tab-bar">
                <button v-for="t in TABS" :key="t.key" class="tab" :class="{ active: currentTab === t.key }" @click="switchTab(t.key)">{{ t.label }}<span class="count">{{ counts[t.key] }}</span></button>
              </div>

              <div class="table-wrap"><div class="table-scroll">
                <table>
                  <thead><tr><th style="width:34%">中文</th><th style="width:38%">英文</th><th>来源</th><th v-if="currentTab === 'custom'" style="width:84px">操作</th></tr></thead>
                  <tbody>
                    <tr v-for="(entry, idx) in currentEntries" :key="idx">
                      <td class="cn">{{ entry.cn }}</td>
                      <td class="en">{{ entry.en }}</td>
                      <td class="src">{{ SRC[currentTab] }}</td>
                      <td v-if="currentTab === 'custom'"><button class="btn danger sm" @click="removeMapping(idx)">删除</button></td>
                    </tr>
                    <tr v-if="!currentEntries.length"><td :colspan="currentTab === 'custom' ? 4 : 3" class="empty">暂无汉化数据</td></tr>
                  </tbody>
                </table>
              </div></div>
            </div>
          </div>

          <div class="sec">
            <div class="dev-card-head" :class="{ open: devCard === 'packets' }" @click="toggleDevCard('packets')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              <div class="srow-info">
                <div class="srow-t">数据包</div>
                <div class="srow-d">查看抓包捕获的原始游戏数据包与解码结果</div>
              </div>
              <svg class="dev-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div v-if="devCard === 'packets'" class="dev-card-body">
              <PacketPane bare />
            </div>
          </div>
        </template>
      </div>

      <!-- ============ 角色仓库 ============ -->
      <div class="pane" :class="{ active: pane === 'stash' }" v-if="pane === 'stash'">
        <StashView
          :char-id="sortCharId"
          :stash-id="sortStashId"
          :stack-mode="sortStack"
          :include-inv="sortIncludeInv"
          :keep-in-place="sortKeepInPlace"
          @update:char-id="v => sortCharId = v"
          @update:stash-id="v => sortStashId = v"
          @update:equipment="v => sortEquipment = v"
          @update:active="v => sortActiveCharId = v"
        />
      </div>

      <!-- ============ 仓库配置 ============ -->
      <div class="pane" :class="{ active: pane === 'sort' }" v-if="pane === 'sort'">
        <SortControl
          :char-id="sortCharId"
          :stash-id="sortStashId"
          :equipment="sortEquipment"
          :active-char-id="sortActiveCharId"
          :stack-mode="sortStack"
          :include-inv="sortIncludeInv"
          :keep-in-place="sortKeepInPlace"
          @update:stack-mode="v => sortStack = v"
          @update:include-inv="v => sortIncludeInv = v"
          @update:keep-in-place="v => sortKeepInPlace = v"
        />
      </div>

      <!-- ============ 使用教程 ============ -->
      <div class="pane" :class="{ active: pane === 'guide' }">
        <div class="page-title">使用教程</div>
        <div class="page-sub">查价器与仓库整理的使用方法，按步骤操作即可上手。</div>

        <div class="sec">
          <div class="sec-label">一、查价器</div>
          <div class="card">
            <div class="steps">
              <div class="step"><div class="step-n">1</div><div class="step-t">启动 DarkTavern，等待主页左栏「OCR 侍者」由灰转金（后端加载模型约数秒，需保持后端在后台运行）</div></div>
              <div class="step"><div class="step-n">2</div><div class="step-t">启动游戏 <b>Dark and Darker</b>，把鼠标<b>悬停</b>在任意物品的提示框上</div></div>
              <div class="step"><div class="step-n">3</div><div class="step-t">按下扫描键（默认 <span class="kbd">{{ scanKey }}</span>，可在查价器页自定义）</div></div>
              <div class="step"><div class="step-n">4</div><div class="step-t">价格面板浮现在物品提示框旁：中文物品名 + 属性 + <b>市场价 / 商人价 / 每格价值</b></div></div>
            </div>
            <div class="about-thanks">
              提示：填入 <b>DarkerDB API Key</b>（F5 → 查价器页）后才有价格数据；未填也能识别物品名与属性。查过的物品自动记入「查价记录」（保留 3 天）。F8 可随时清除悬浮窗。
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">二、自动整理</div>
          <div class="card">
            <div class="card-note">
              前置条件：已安装 <b>Wireshark</b>（提供 tshark，安装时勾选 "Add tshark to PATH"）；若游戏以管理员权限运行，DarkTavern 也需<b>以管理员身份运行</b>，否则鼠标操作会被 Windows 拦截。
            </div>
            <div class="steps">
              <div class="step"><div class="step-n">1</div><div class="step-t">进入「角色仓库」页，点击<b>启动抓包</b>，再<b>回到游戏角色选择界面选择角色</b>（游戏只在选角时下发仓库数据），角色的仓库与背包数据即自动出现；数据保存在本地，重启不用重抓</div></div>
              <div class="step"><div class="step-n">2</div><div class="step-t">在仓库网格上方选择<b>排序方案</b>（默认整理 / 品质区分 / 装备优先），可先点「排序预览」确认摆放效果</div></div>
              <div class="step"><div class="step-n">3</div><div class="step-t">进入「仓库配置」页，选择要整理的<b>角色与目标仓库</b>，按需调整整理速度、堆叠合并、包含背包</div></div>
              <div class="step"><div class="step-n">4</div><div class="step-t">游戏中确认仓库界面已打开，按下 <span class="kbd">{{ sortHotkey }}</span> 开始整理；整理期间<b>保持游戏窗口在前台、不要移动鼠标</b></div></div>
              <div class="step"><div class="step-n">5</div><div class="step-t">随时可按 <span class="kbd">{{ cancelHotkey }}</span> 中断；结束后查看整理结果，误放可手动微调</div></div>
            </div>
            <div class="about-thanks">
              提示：整理速度建议先用「中」，出现漏放/串位再降到「慢」；「极速」约 10 倍提速但偶发漏操作。Ctrl+E 可在仓库间循环切换。
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">三、工作原理 · 技术透明</div>
          <div class="terms-grid">
            <div class="card term-card">
              <div class="term-head">查价原理</div>
              <div class="term-body">
                <p>查价本质是<b>「看屏幕 + 查网站」</b>的自动化：</p>
                <ul>
                  <li>用 Windows 系统 API 按窗口标题<b>找到</b>游戏窗口（只查询位置，不操作）</li>
                  <li>用 mss 截取鼠标悬停区域的<b>屏幕像素</b>（和你截图一样，纯读屏）</li>
                  <li>在本机用 AI 识别：YOLO 模型检测提示框位置 → OCR 识别中文 → 词条映射中译英</li>
                  <li>把识别结果发往 <b>darkerdb.com</b>（使用你自己填的 API Key）获取价格</li>
                  <li>结果叠在游戏画面上显示</li>
                </ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">整理原理</div>
              <div class="term-body">
                <p>整理本质是<b>「看数据 + 动手拖」</b>的自动化：</p>
                <ul>
                  <li>用 tshark 对游戏网络流量做<b>被动监听</b>（只接收、不发任何数据包、不修改任何数据）</li>
                  <li>本地解码出仓库布局并展示（就是角色仓库页看到的样子）</li>
                  <li>排序算法在本地算出最佳摆放方案（纯数学计算）</li>
                  <li>通过 Windows 系统 API（SendInput）<b>模拟真实鼠标移动与拖拽</b>，和你亲手拖动物品的操作一模一样</li>
                  <li>内置安全监视器：检测到窗口失焦、位置漂移会自动暂停，防止误操作</li>
                </ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">为什么它不是外挂</div>
              <div class="term-body">
                <p>外挂（作弊程序）的共同特征是<b>侵入游戏本体</b>：读取/修改游戏内存、注入 DLL、篡改网络数据包、修改游戏文件。DarkTavern 一样都不做：</p>
                <ul>
                  <li>全程<b>不碰游戏进程</b>——不注入、不读内存、不写内存</li>
                  <li>不修改游戏文件、不绕过反作弊、不提供游戏内优势操作</li>
                  <li>查价的数据完全来自游戏<b>自己显示在屏幕上的内容</b>，不获取任何游戏外信息</li>
                  <li>整理只做「眼睛看得到、手做得到」的操作：模拟鼠标拖拽</li>
                </ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">数据与隐私</div>
              <div class="term-body">
                <ul>
                  <li>所有识别、计算都在<b>本机</b>完成，不上传截图、不上传仓库数据</li>
                  <li>网络请求只发往 darkerdb.com（查价）与本地后端（127.0.0.1），不带任何个人身份信息</li>
                  <li>设置与查价记录仅保存在本机用户目录</li>
                  <li>是否安装/使用第三方工具，属于各游戏自带的条款约定范围，请自行查阅并判断</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">四、快捷键速查</div>
          <div class="card">
            <div class="term-body">
              <ul>
                <li><span class="kbd">{{ scanKey }}</span> 扫描悬停物品价格</li>
                <li><span class="kbd">F5</span> 设置（API Key、扫描键、扫描模式）　<span class="kbd">F6</span> 词条编辑器　<span class="kbd">F7</span> 调试模式　<span class="kbd">F8</span> 清除悬浮窗</li>
                <li><span class="kbd">{{ sortHotkey }}</span> 开始整理　<span class="kbd">{{ cancelHotkey }}</span> 取消整理　<span class="kbd">Ctrl+E</span> 切换仓库</li>
                <li><span class="kbd">Ctrl+Alt+B</span> 锁定 / 解锁桌面悬浮球</li>
              </ul>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">五、常见问题</div>
          <div class="terms-grid">
            <div class="card term-card">
              <div class="term-head">OCR 状态一直「正在唤醒」</div>
              <div class="term-body">
                <p>多为代理 / VPN 干扰本地后端通信（127.0.0.1）。关闭 TUN / 全局增强模式后重启一次；或临时关闭代理启动。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">查价没有价格数据</div>
              <div class="term-body">
                <p>未填 DarkerDB API Key。F5 → 查价器页填入 Key 并保存（darkerdb.com 免费注册获取）。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">整理时鼠标不动 / 被拦截</div>
              <div class="term-body">
                <p>游戏以管理员权限运行时，DarkTavern 也需以管理员身份运行（右键 → 以管理员身份运行），或取消游戏快捷方式的管理员选项。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">角色仓库没有数据</div>
              <div class="term-body">
                <p>确认已安装 Wireshark（提供 tshark）；在「角色仓库」页启动抓包后，<b>回到游戏角色选择界面重新选择该角色</b>——游戏只在选角时下发全量仓库数据，仅在游戏内打开仓库界面是拿不到数据的。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">整理漏放 / 串位</div>
              <div class="term-body">
                <p>把整理速度从「极速」降到「中」或「慢」；整理期间保持窗口前台、不要移动鼠标和切窗口。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">这算外挂吗？会不会封号？</div>
              <div class="term-body">
                <p>不是外挂：不注入、不读游戏内存、不改数据包，只做「看屏幕 + 看网络 + 模拟鼠标」三件事，详见本页「工作原理 · 技术透明」与「安全说明」。</p>
                <p>但任何第三方工具都与游戏条款存在约定冲突的可能，使用与否请自行判断，风险条款见「免责声明」页。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">其他问题</div>
              <div class="term-body">
                <p>在交流群提问（侧边栏「交流群」可复制群号），或到 GitHub Issues 反馈；附上日志（用户目录 darktavern/logs）能更快定位。</p>
              </div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">安全说明 · 一句话讲清楚</div>
          <div class="card">
            <div class="term-body">
              <p>DarkTavern <b>不是外挂</b>。它对你的电脑只做四件事，且全部是<b>人类自己也能做</b>的事：</p>
              <ul>
                <li><b>看屏幕</b>：截取游戏画面像素，用 OCR 识别物品提示框文字 —— 相当于你用自己的眼睛看</li>
                <li><b>看网络</b>：被动监听游戏网络数据，解码出仓库布局 —— 相当于你打开仓库看一眼</li>
                <li><b>动鼠标</b>：用 Windows 系统 API 模拟鼠标移动和拖拽 —— 相当于你亲手拖动物品，游戏完全无法区分</li>
                <li><b>查网站</b>：把识别出的物品名发往 darkerdb.com 查公开价格 —— 相当于你手动打开网站搜索</li>
              </ul>
              <p>它<b>从来不做</b>的：不注入 DLL、不读取或修改游戏内存、不修改游戏文件、不篡改或伪造网络数据包、不读写存档、不提供任何游戏内"优势操作"。整个程序连游戏进程都不会触碰，自然也无法从中获取任何"作弊级"信息。</p>
            </div>
            <div class="about-thanks">
              请记住：任何第三方工具都可能与游戏条款存在约定冲突，使用与否请自行判断。完整责任条款见「免责声明」页。
            </div>
          </div>
        </div>

        <div class="about-note">
          <em>放心使用：</em>查价 = 看屏幕 + 查网站；整理 = 看数据 + 模拟鼠标。全程不注入、不读内存、不碰游戏进程，更不联网上传你的任何游戏数据。
        </div>
      </div>

      <!-- ============ 关于酒馆 ============ -->
      <div class="pane" :class="{ active: pane === 'about' }">
        <div class="page-title">关于酒馆</div>
        <div class="page-sub">了解 DarkTavern 的身份、愿景、软件来源与致谢。</div>

        <div class="keeper">
          <div class="keeper-glow"></div>
          <div class="keeper-top">
            <div class="keeper-seal"><img :src="adminAvatar" alt="方源Official" /></div>
            <div class="keeper-idblock">
              <div class="keeper-name">方源Official</div>
              <div class="keeper-role">
                <span class="keeper-badge">酒馆掌柜</span>
                <span class="keeper-badge alt">独立开发者</span>
              </div>
            </div>
            <div class="keeper-open"><span class="keeper-open-dot"></span>为爱营业中</div>
          </div>
          <div class="keeper-vision">
            <p class="keeper-lead">和你一样，我也是一名热爱 <em>Dark and Darker</em> 的普通玩家——曾在漆黑的地牢裡，为一件装备到底值不值而反复纠结。于是，我决定自己动手。</p>
            <p class="keeper-body">DarkTavern 改编自原版查价器 GrimVault 与开源中文版 GrimVault-Chinese-Edition。最初我基于中文版延续开发，后来因后续维护问题，不愿再麻烦原作者，便潜心研读源码，将软件<strong>完整重写</strong>。没有团队、没有盈利，只是一个玩家想帮玩家的小小心意——愿它让你的每一次冒险，都心中有数、满载而归。</p>
          </div>
          <div class="about-contacts">
            <a class="contact-chip" href="#" @click.prevent="openLink('https://space.bilibili.com/301927878')">
              <span class="contact-ic bili">哔</span>
              <span class="contact-txt"><span class="contact-k">哔哩哔哩</span><span class="contact-v">方源Official</span></span>
            </a>
            <a class="contact-chip" href="#" @click.prevent="copyGroup">
              <span class="contact-ic qq">群</span>
              <span class="contact-txt"><span class="contact-k">德鲁伊的树屋酒馆</span><span class="contact-v">237874334</span></span>
            </a>
            <a class="contact-chip" href="#" @click.prevent="openLink('mailto:1292517294@qq.com')">
              <span class="contact-ic mail">邮</span>
              <span class="contact-txt"><span class="contact-k">邮箱</span><span class="contact-v">1292517294@qq.com</span></span>
            </a>
            <a class="contact-chip" href="#" @click.prevent="copyWechat">
              <span class="contact-ic wechat">微</span>
              <span class="contact-txt"><span class="contact-k">商务合作 · 微信</span><span class="contact-v">ZFZ13434</span></span>
            </a>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">软件来源 · 致敬</div>
          <div class="card">
            <div class="about-block">
              <p>本软件改编自原版查价器 <a href="#" @click.prevent="openLink('https://github.com/DarkerDB/GrimVault')">GrimVault</a>、开源中文版 <a href="#" @click.prevent="openLink('https://github.com/Songyt1110/GrimVault-Chinese-Edition')">GrimVault-Chinese-Edition</a>，仓库整理功能则参考了 <a href="#" @click.prevent="openLink('https://github.com/Beelzebub2/DnDTools')">DnDTools</a>。</p>
              <p>遵从前辈们的开源精神，DarkTavern 也已<strong>全部开源</strong>至 <a href="#" @click.prevent="openGithub">GitHub</a>。诚挚感谢 GrimVault、GrimVault-Chinese-Edition 与 DnDTools 铺就的道路，也感谢一路上每一位支持与帮助过我的朋友。</p>
            </div>
            <div class="src-links">
              <a class="src-card" href="#" @click.prevent="openLink('https://github.com/DarkerDB/GrimVault')">
                <span class="src-name">GrimVault</span>
                <span class="src-desc">原版查价器 · 灵感之源</span>
              </a>
              <a class="src-card" href="#" @click.prevent="openLink('https://github.com/Songyt1110/GrimVault-Chinese-Edition')">
                <span class="src-name">GrimVault-Chinese-Edition</span>
                <span class="src-desc">开源中文版 · 传承之基</span>
              </a>
              <a class="src-card" href="#" @click.prevent="openLink('https://github.com/Beelzebub2/DnDTools')">
                <span class="src-name">DnDTools</span>
                <span class="src-desc">仓库整理工具 · 参考来源</span>
              </a>
              <a class="src-card" href="#" @click.prevent="openGithub">
                <span class="src-name">DarkTavern</span>
                <span class="src-desc">本项目源码 · 开源续写</span>
              </a>
            </div>
            <div class="about-thanks">感谢所有开源前辈的无私分享，感谢每一位支持与帮助过我的朋友！</div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">仓库整理 · 致谢</div>
          <div class="card">
            <div class="about-block">
              <p>DarkTavern 的<b>角色仓库与自动整理</b>功能参考自开源项目 <a href="#" @click.prevent="openLink('https://github.com/Beelzebub2/DnDTools')">DnDTools</a>——它用网络抓包把仓库可视化的思路给了我极大的启发：抓包解析物品数据、仓库布局可视化、排序算法与整理执行，均在此基础上移植与重写。</p>
              <p>诚挚感谢 DnDTools 项目的无私开源，让「一键整理仓库」这件玩家苦差事变成了可能，也感谢每一位为玩家社区贡献工具的朋友！</p>
            </div>
            <div class="src-links single">
              <a class="src-card" href="#" @click.prevent="openLink('https://github.com/Beelzebub2/DnDTools')">
                <span class="src-name">DnDTools</span>
                <span class="src-desc">仓库抓包整理工具 · 功能参考来源</span>
              </a>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">数据来源 · 致谢</div>
          <div class="card">
            <div class="about-block">
              <p>本工具的市场数据来源于 <a href="#" @click.prevent="openLink('https://darkerdb.com/')">DarkerDB</a>，这是一个优秀的游戏数据平台。感谢 DarkerDB 提供了准确、实时的市场数据，让装备估价与市场价格分析功能得以实现。</p>
              <p>诚挚地感谢 DarkerDB 及其作者 <strong>Anders</strong> 对游戏社区的无私贡献！同时感谢所有为本站提供数据和反馈的玩家社区！</p>
            </div>
            <div class="src-links single">
              <a class="src-card" href="#" @click.prevent="openLink('https://darkerdb.com/')">
                <span class="src-name">DarkerDB</span>
                <span class="src-desc">游戏数据平台 · 市场数据来源</span>
              </a>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">姐妹项目 · 冒险者酒馆</div>
          <div class="card">
            <div class="about-block">
              <p><a href="#" @click.prevent="openLink('https://dnd.wiki/')">冒险者酒馆</a>（dnd.wiki）是掌柜的另一部个人作品——Dark and Darker 中英双语 Wiki / 数据库网站：职业 / 装备 / 怪物图鉴、配装模拟与社区配装、市场分析、伤害计算器、排行榜与掉率查询，一应俱全。</p>
              <p>DarkTavern 的中→英翻译词条表与物品数据同冒险者酒馆共用一套数据源：桌面端负责「要看屏幕的」（游戏内查价 / 仓库整理），网站负责「不用看屏幕的」（数据库 / 配装 / 市场），两边互补，欢迎常来坐坐！</p>
            </div>
            <div class="src-links single">
              <a class="src-card" href="#" @click.prevent="openLink('https://dnd.wiki/')">
                <span class="src-name">冒险者酒馆</span>
                <span class="src-desc">中英双语 Wiki · 掌柜姐妹之作</span>
              </a>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">条款与声明</div>
          <div class="terms-grid">
            <div class="card term-card">
              <div class="term-head">免责声明</div>
              <div class="term-body">
                <p>本站所有内容仅供玩家参考，不构成任何投资建议。游戏数据可能随时变化，请以游戏内实际数据为准。</p>
                <ul><li>尽力确保信息准确性</li><li>不保证内容永久有效</li><li>第三方链接不代表本站立场</li></ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">服务条款</div>
              <div class="term-body">
                <p>使用本站即表示您同意以下条款：</p>
                <ul><li>禁止非法用途</li><li>禁止发布违规内容</li><li>禁止侵犯他人权益</li><li>禁止干扰网站运行</li></ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">隐私政策</div>
              <div class="term-body">
                <p>我们高度重视您的隐私：</p>
                <ul><li>不收集任何信息</li><li>保护您的数据安全</li><li>不出售任何个人信息</li></ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">知识产权</div>
              <div class="term-body">
                <p>关于本站内容版权：</p>
                <ul><li>游戏数据来源于社区与官方公开数据</li><li>原创内容归本站所有</li><li>引用需注明来源</li><li>欢迎社区贡献内容</li></ul>
              </div>
            </div>
          </div>
        </div>

        <div class="about-note">
          本工具与游戏 <em>Dark and Darker</em> 没有任何形式的官方联系、隶属关系、授权或认可。所有功能均免费开放，力求内容准确但无法保证百分之百精确完整。
        </div>
      </div>

      <!-- ============ 免责声明 ============ -->
      <div class="pane" :class="{ active: pane === 'disclaimer' }">
        <div class="page-title">免责声明</div>
        <div class="page-sub">使用 DarkTavern 即表示您已阅读并同意以下全部条款，请在使用前仔细阅读。</div>

        <div class="about-note note-lead">
          <em>使用即同意：</em>您下载、安装、使用或分发本软件的任何行为，均视为已阅读、理解并无条件同意本声明全部内容。如不同意，请立即停止使用并删除本软件。
        </div>

        <div class="sec">
          <div class="sec-label">一、软件性质</div>
          <div class="card">
            <div class="term-body">
              <p>DarkTavern 是第三方玩家自制、以 MIT 许可证免费开源的独立工具。它与 Ironmace、游戏《Dark and Darker》及其开发者、发行商、代理商之间<strong>不存在任何形式的隶属、关联、授权、认可或合作关系</strong>。</p>
              <p>本工具仅用于个人学习、研究与娱乐目的，作者未向任何用户收取费用，也不对任何用户的使用行为负责。</p>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">二、游戏账号风险（请务必阅读）</div>
          <div class="terms-grid">
            <div class="card term-card">
              <div class="term-head">封禁与处罚</div>
              <div class="term-body">
                <p>因使用本工具导致的任何账号处罚，全部风险与后果由使用者自行承担：</p>
                <ul>
                  <li>临时或永久封禁账号</li>
                  <li>限制交易 / 拍卖行 / 组队等游戏功能</li>
                  <li>限制登录或强制下线</li>
                  <li>降低账号信用或声誉</li>
                </ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">虚拟财产损失</div>
              <div class="term-body">
                <p>包括但不限于以下损失，作者一律不承担任何责任：</p>
                <ul>
                  <li>金币、道具、装备等虚拟财产损失</li>
                  <li>角色数据、成就与游戏进度损失</li>
                  <li>账号本身的价值贬损或无法找回</li>
                  <li>因处罚产生的间接经济损失</li>
                </ul>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">官方条款冲突</div>
              <div class="term-body">
                <p>游戏官方用户协议、服务条款或公告可能明示或暗示禁止第三方工具。使用者需自行确认使用行为合规，并承担由此产生的全部后果。游戏运营方随时可能更新政策或调整检测手段，本工具<strong>不保证</strong>始终被允许使用。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">自查义务</div>
              <div class="term-body">
                <ul>
                  <li>使用前请自行查阅游戏最新规则</li>
                  <li>建议先在小号试用，确认无风险再用于主账号</li>
                  <li>任何账号问题请第一时间联系游戏官方客服</li>
                  <li>本工具不提供任何账号申诉或恢复协助</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">三、功能与使用风险</div>
          <div class="terms-grid">
            <div class="card term-card">
              <div class="term-head">自动整理</div>
              <div class="term-body">
                <p>自动整理通过模拟鼠标操作完成，可能因游戏界面变动、网络延迟、窗口失焦等原因产生误操作。使用前请确认已打开仓库界面且游戏窗口在前台。因误操作导致的物品错放、误卖、丢失等，由使用者自行承担。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">网络抓包</div>
              <div class="term-body">
                <p>仓库可视化基于游戏网络数据解析，仅在本机展示与整理。请勿将捕获的数据用于任何非法用途；作者不对数据被滥用造成的后果负责。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">下载安全</div>
              <div class="term-body">
                <p>请仅从官方渠道（GitHub 仓库与官方 Release）获取本软件与更新。从非官方渠道下载的修改版可能包含恶意代码，由此造成的一切损失作者不承担任何责任。</p>
              </div>
            </div>
            <div class="card term-card">
              <div class="term-head">运行环境</div>
              <div class="term-body">
                <p>本工具在 Windows 平台开发与测试。在其他系统、虚拟机、云电脑或与第三方检测软件共存等环境下出现的问题，作者不保证修复，亦不承担责任。</p>
              </div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">四、数据与准确性</div>
          <div class="card">
            <div class="term-body">
              <p>本工具展示的价格、属性、翻译等数据来自第三方公开数据（如 DarkerDB API），可能存在延迟、错误或过时。作者不保证数据的准确性、完整性、时效性，相关内容<strong>不构成任何投资、交易或游戏行为建议</strong>。用户依据本工具做出的任何游戏内决策，后果自行承担。</p>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">五、知识产权</div>
          <div class="card">
            <div class="term-body">
              <p>游戏中出现的名称、美术、数据等知识产权归 Ironmace 或其授权方所有。本软件包含并依赖多个第三方开源项目与模型（GrimVault、RapidOCR、PaddleOCR 等），各自按其许可证提供；本软件名称与图标为作者品牌标识，详见 LICENSE。</p>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">六、责任免除（最大程度）</div>
          <div class="card">
            <div class="term-body">
              <p>本软件按「现状」（AS IS）提供，作者不作任何明示或暗示担保，包括但不限于适销性、特定用途适用性、无侵权。不担保软件无错误、无中断、无病毒，也不担保与您的系统或游戏版本兼容。</p>
              <p>在法律允许的最大范围内，作者对因使用或无法使用本软件造成的任何直接、间接、偶然、特殊或惩罚性损害概不负责，包括但不限于利润损失、数据丢失、硬件损坏、游戏账号损失（含封禁、限制、虚拟财产损失）。若当地法律不允许部分限制，则相应部分以当地法律允许的最大范围为准。</p>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">七、隐私</div>
          <div class="card">
            <div class="term-body">
              <p>本工具不收集、不上传任何个人信息；设置、日志与查询记录仅保存在本机。查价请求仅携带用户自行填写的 API Key 发送至 DarkerDB 官方接口，作者无法获取也无法保存您的 API Key。</p>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">八、条款更新</div>
          <div class="card">
            <div class="term-body">
              <p>作者保留随时修改本声明的权利，更新后不再另行通知，继续使用即视为接受更新后的条款。请以 GitHub 仓库中的最新版本为准。</p>
            </div>
          </div>
        </div>

        <div class="about-note">
          <em>最后提醒：</em>使用第三方工具始终存在未知风险。如您对游戏账号十分珍视，建议谨慎使用；任何因使用本工具产生的问题，请第一时间停止使用并通过 GitHub Issues 反馈，但作者不承担任何赔偿义务。
        </div>
      </div>

      <!-- ============ 赞助酒馆 ============ -->
      <div class="pane" :class="{ active: pane === 'sponsor' }">
        <div class="page-title">赞助酒馆</div>
        <div class="page-sub">如果您觉得这个工具对您有帮助，可以考虑请我喝杯咖啡。您的认可是我持续投入和更新的最大鼓励。</div>

        <!-- 赞助名人堂（暂时隐藏）
        <div class="sponsor-hall">
          <div class="hall-title">
            <svg class="hall-crown" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z"/></svg>
            <h2>赞助名人堂</h2>
            <svg class="hall-crown" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z"/></svg>
          </div>
          <div class="hall-top3">
            <div v-for="(d, i) in topDonors" :key="'top'+i" class="hall-card" :class="'rank-' + hallRank(i)">
              <div class="hall-avatar"><img v-if="d.avatar" :src="d.avatar" :alt="d.name"><span v-else>{{ donorInitial(d.name) }}</span></div>
              <div class="hall-name">{{ d.name }}</div>
              <div class="hall-amount">¥ {{ d.amount }}</div>
            </div>
          </div>
          <div class="hall-list-wrap"><div class="hall-list">
            <div v-for="(d, i) in remainingDonors" :key="'d'+i" class="hall-item">
              <div class="hall-item-avatar"><img v-if="d.avatar" :src="d.avatar" :alt="d.name"><span v-else>{{ donorInitial(d.name) }}</span></div>
              <span class="hall-item-name">{{ d.name }}</span>
              <span class="hall-item-amount">¥ {{ d.amount }}</span>
            </div>
          </div></div>
          <div class="hall-thanks">
            <span class="hall-thanks-title">感谢所有支持者的鼓励！</span>
            <span class="hall-thanks-sub">您的认可是我持续更新和优化的最大动力</span>
          </div>
        </div>
        -->

        <div class="sec">
          <div class="sec-label">捐赠方式</div>
          <div class="pay-grid">
            <div class="card pay-card">
              <div class="pay-label wechat">微信支付</div>
              <div class="pay-qr"><img src="@assets/images/wechat_pay.webp" alt="微信支付二维码"></div>
            </div>
            <div class="card pay-card">
              <div class="pay-label alipay">支付宝</div>
              <div class="pay-qr"><img src="@assets/images/alipay_pay.webp" alt="支付宝二维码"></div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">您的支持如何帮助本站</div>
          <div class="usage-grid">
            <div class="card usage-card"><div class="usage-t">服务器费用</div><div class="usage-d">保持网站稳定运行</div></div>
            <div class="card usage-card"><div class="usage-t">技术维护</div><div class="usage-d">持续优化与更新</div></div>
            <div class="card usage-card"><div class="usage-t">内容创作</div><div class="usage-d">丰富游戏攻略与数据</div></div>
            <div class="card usage-card"><div class="usage-t">社区运营</div><div class="usage-d">维护健康交流环境</div></div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label">免责声明与赞助条款</div>
          <div class="card">
            <div class="about-block"><p>欢迎您通过自愿赞助支持本站。在您决定进行赞助之前，请仔细阅读本声明：</p></div>
            <div class="clause-list">
              <div class="clause"><span class="clause-n">1</span><div><div class="clause-t">赞助的性质</div><div class="clause-d">一切赞助均为自愿性无偿捐赠，不构成任何形式的商品买卖或服务提供。</div></div></div>
              <div class="clause"><span class="clause-n">2</span><div><div class="clause-t">无偿性与回报</div><div class="clause-d">您的赞助不会换取任何形式的商品、服务、独家内容或特权。</div></div></div>
              <div class="clause"><span class="clause-n">3</span><div><div class="clause-t">非合同关系</div><div class="clause-d">赞助不建立任何法律约束力关系，本站不对赞助者承担任何义务。</div></div></div>
              <div class="clause"><span class="clause-n">4</span><div><div class="clause-t">退款政策</div><div class="clause-d">所有赞助为最终捐赠，恕不接受任何退款请求。</div></div></div>
              <div class="clause warn"><span class="clause-n">5</span><div><div class="clause-t">警惕冒仿</div><div class="clause-d">任何声称是本站作者并主动联系您的均为诈骗！作者不会私下联系您、索取费用或指导操作。谨防上当！</div></div></div>
              <div class="clause"><span class="clause-n">6</span><div><div class="clause-t">最终解释权</div><div class="clause-d">在法律允许的范围内，本网站保留对本免责声明及赞助条款的最终解释权。</div></div></div>
            </div>
            <div class="clause-agree">通过访问和使用本站，即表示您已阅读、理解并同意本声明的全部内容。</div>
          </div>
        </div>

        <div class="about-note">© 2026 方源Official · 如有疑问请联系：1292517294@qq.com</div>
      </div>
    </div>
  </div>

  <div class="toast" :class="{ show: toastShow }">{{ toastMsg }}</div>
</template>
