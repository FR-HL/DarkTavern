<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

const invoke = (channel, data) => window.electron.invoke (channel, data);

const TABS = [
  { key: 'custom', label: '自定义' },
  { key: 'items', label: '物品' },
  { key: 'attributes', label: '属性' },
  { key: 'keywords', label: '关键词' },
];
const SRC = { custom: '自定义', items: '物品', attributes: '属性', keywords: '关键词' };

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

const allMappings = reactive ({ items: {}, attributes: {}, keywords: {}, custom: {} });
const currentTab = ref ('custom');
const search = ref ('');
const editingRow = ref (null);
const editingCn = ref ('');
const editingEn = ref ('');
const cnInput = ref ('');
const enInput = ref ('');
const mappingsLoaded = ref (false);

let lastMappings = -1;
let toastTimer = null;
let settingsTimer = null;
let mappingTimer = null;
let scaleTimer = null;
let healthTimer = null;
let healthInited = false;
let windowTimer = null;
let uptimeTimer = null;
const startMs = Date.now ();

const headline = computed (() => {
  if (!ocrOk.value) return '侍者正在备酒';
  if (!gameOk.value) return '酒馆已经开张';
  return '万事俱备 · 悬停即知价';
});
const sub = computed (() => {
  if (!ocrOk.value) return 'OCR 引擎唤醒中，请稍候片刻…';
  if (!gameOk.value) return '启动游戏、把鼠标悬停在物品上即可查价';
  return '已检测到游戏窗口，按下 ' + scanKey.value + ' 开始';
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

function showPane (name) { pane.value = name; }

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

function copyGroup () { window.electron.clipboardWriteText ('376490002'); showToast ('群号已复制'); }
function openGithub () { window.electron.openExternal ('https://github.com/FR-HL/DarkTavern'); }

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

async function pollHealth () {
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
      if (!healthInited) {
        healthInited = true;
        clearInterval (healthTimer);
        healthTimer = setInterval (pollHealth, 5000);
      }
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

async function pollWindow () {
  try {
    const d = await invoke ('backend:window');
    if (d && d.found) { gameOk.value = true; setRune ('game', 'ok', '已检测到', 'var(--teal)'); }
    else { gameOk.value = false; setRune ('game', 'pending', '等待游戏…', 'var(--ink-faint)'); }
  } catch (e) {
    gameOk.value = false;
    setRune ('game', 'pending', '等待游戏…', 'var(--ink-faint)');
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
  } catch (e) { showMappingStatus ('OCR 服务未运行，请先启动应用。', 'error'); }
}
function switchTab (tab) { currentTab.value = tab; editingRow.value = null; }
function startEdit (idx) {
  editingRow.value = idx;
  editingCn.value = currentEntries.value[idx].cn;
  editingEn.value = currentEntries.value[idx].en;
}
function cancelEdit () { editingRow.value = null; }
async function saveEdit (idx) {
  const entry = currentEntries.value[idx];
  if (!entry) return;
  const nc = editingCn.value.trim (), ne = editingEn.value.trim ();
  if (!nc || !ne) { showMappingStatus ('中文和英文都不能为空', 'error'); return; }
  try {
    if (nc !== entry.cn) await invoke ('chinese:remove-mapping', { chinese: entry.cn });
    await invoke ('chinese:add-mapping', { chinese: nc, english: ne });
    showToast ('已保存');
    editingRow.value = null;
    await loadMappings ();
  } catch (e) { showMappingStatus ('保存失败：' + e.message, 'error'); }
}
async function addMapping () {
  const cn = cnInput.value.trim (), en = enInput.value.trim ();
  if (!cn || !en) { showMappingStatus ('请填写中文和英文', 'error'); return; }
  try {
    await invoke ('chinese:add-mapping', { chinese: cn, english: en });
    cnInput.value = ''; enInput.value = '';
    showMappingStatus ('已添加：' + cn + ' → ' + en, 'success');
    await loadMappings ();
    switchTab ('custom');
  } catch (e) { showMappingStatus ('添加失败：' + e.message, 'error'); }
}
async function removeMapping (idx) {
  const entry = currentEntries.value[idx];
  if (!entry) return;
  if (!confirm ('确定删除 “' + entry.cn + '” 吗？')) return;
  try {
    await invoke ('chinese:remove-mapping', { chinese: entry.cn });
    showToast ('已删除');
    await loadMappings ();
  } catch (e) { showMappingStatus ('删除失败：' + e.message, 'error'); }
}

onMounted (() => {
  window.electron.on ('navigate', (p) => { if (p) showPane (p); });
  document.addEventListener ('keydown', onKeyDown);
  document.addEventListener ('mousedown', onMouseDown);
  uptimeTimer = setInterval (tick, 1000);
  pollHealth ();
  healthTimer = setInterval (pollHealth, 1200);
  pollWindow ();
  windowTimer = setInterval (pollWindow, 2000);
  loadSettings ();
});

onBeforeUnmount (() => {
  document.removeEventListener ('keydown', onKeyDown);
  document.removeEventListener ('mousedown', onMouseDown);
  clearInterval (uptimeTimer);
  clearInterval (healthTimer);
  clearInterval (windowTimer);
});
</script>

<template>
  <div class="fog fog-ember"></div>
  <div class="fog fog-a"></div>
  <div class="fog fog-b"></div>

  <div class="app">
    <aside class="side">
      <div class="side-brand">
        <div class="side-sig">DT</div>
        <div><div class="nm">DarkTavern</div><div class="ey">Dark and Darker</div></div>
      </div>
      <nav class="nav">
        <div class="nav-label">导航</div>
        <div class="nav-item" :class="{ active: pane === 'overview' }" @click="showPane('overview')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
          概览
        </div>
        <div class="nav-item" :class="{ active: pane === 'general' }" @click="showPane('general')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.2" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="2.2" fill="currentColor" stroke="none"/></svg>
          常规
        </div>
        <div class="nav-item" :class="{ active: pane === 'scan' }" @click="showPane('scan')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
          扫描
        </div>
        <div class="nav-item" :class="{ active: pane === 'mapping' }" @click="showPane('mapping')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>
          数据汉化
        </div>
      </nav>
      <div class="side-foot">
        <div class="shield"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>仅读屏 · 不注入</div>
        交流群 <span class="grp" @click="copyGroup">376490002</span><br>
        <a href="#" @click.prevent="openGithub">开源 · GitHub</a>
      </div>
    </aside>

    <div class="content">
      <div class="pane" :class="{ active: pane === 'overview' }">
        <div class="ov-head">
          <div class="ov-ey"><span class="live-dot"></span>酒馆情报</div>
          <div class="ov-headline">{{ headline }}</div>
          <div class="ov-sub">{{ sub }}</div>
        </div>

        <div class="metric-grid">
          <div class="metric"><div class="metric-k">汉化数据</div><div class="metric-v gold">{{ mMappings }}</div></div>
          <div class="metric"><div class="metric-k">本次会话</div><div class="metric-v teal">{{ uptime }}</div></div>
          <div class="metric"><div class="metric-k">服务版本</div><div class="metric-v ink"><span class="ok-dot" :class="{ bad: verDotBad }"></span><span>{{ version }}</span></div></div>
        </div>

        <div class="ov-grid">
          <section class="card">
            <div class="card-pad">
              <div class="card-head"><span class="card-title">实时状态</span></div>
              <div class="rune-row"><div class="rune" :data-state="runes.ocr.state"></div><div><div class="rune-k">OCR 侍者</div><div class="rune-v" :style="{ color: runes.ocr.color }">{{ runes.ocr.text }}</div></div></div>
              <div class="rune-row"><div class="rune" :data-state="runes.game.state"></div><div><div class="rune-k">游戏窗口</div><div class="rune-v" :style="{ color: runes.game.color }">{{ runes.game.text }}</div></div></div>
              <div class="rune-row"><div class="rune" :data-state="runes.key.state"></div><div><div class="rune-k">扫描热键</div><div class="rune-v" :style="{ color: runes.key.color }">{{ runes.key.text }}</div></div></div>
              <div class="rune-row"><div class="rune" :data-state="runes.api.state"></div><div><div class="rune-k">DarkerDB API</div><div class="rune-v" :style="{ color: runes.api.color }">{{ runes.api.text }}</div></div></div>
              <div class="rune-foot"><svg class="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg><span>不读取游戏内存</span></div>
            </div>
          </section>
          <section class="card">
            <div class="card-pad">
              <div class="card-head"><span class="card-title">三步上手</span></div>
              <div class="steps">
                <div class="step"><div class="step-n">1</div><div class="step-t">启动 <b>Dark and Darker</b>（中文客户端）</div></div>
                <div class="step"><div class="step-n">2</div><div class="step-t">把鼠标 <b>悬停</b> 在任意物品上</div></div>
                <div class="step"><div class="step-n">3</div><div class="step-t">按下 <span class="kbd">{{ scanKey }}</span> 即刻查价</div></div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div class="pane" :class="{ active: pane === 'general' }">
        <div class="pane-title">常规</div>
        <div class="pane-desc">账号凭证与启动行为。</div>
        <div class="group">
          <div class="group-h">DarkerDB API Key</div>
          <div class="row"><label>API Key</label><div class="grow" style="display:flex; gap:8px;"><input :type="apiKeyVisible ? 'text' : 'password'" v-model="apiKey" placeholder="输入你的 DarkerDB API Key"><button class="btn ghost" @click="toggleApiKeyVisibility">{{ apiKeyVisible ? '隐藏' : '显示' }}</button></div></div>
          <div class="row"><label></label><span class="hint">在 darkerdb.com 注册获取，填入后查价更快、数据更完整。</span></div>
          <div class="row"><label></label><button class="btn primary" @click="saveApiKey">保存 API Key</button></div>
        </div>
        <div class="group">
          <div class="group-h">启动</div>
          <div class="row"><label>开机启动</label><div class="grow" style="display:flex; align-items:center; justify-content:space-between;"><span class="hint">登录系统时自动在后台运行 DarkTavern。</span><label class="switch"><input type="checkbox" v-model="launchOnStartup" @change="saveLaunch"><span class="track"></span></label></div></div>
        </div>
        <div class="status" :class="settingsStatus.type">{{ settingsStatus.text }}</div>
      </div>

      <div class="pane" :class="{ active: pane === 'scan' }">
        <div class="pane-title">扫描</div>
        <div class="pane-desc">触发键、模式与悬浮窗外观。</div>
        <div class="group">
          <div class="group-h">扫描触发键</div>
          <div class="row"><label>当前按键</label><span class="kbd">{{ scanKey }}</span></div>
          <div class="row"><label>修改按键</label><button class="keybind-btn" :class="{ listening: isListening }" @click="startListening">{{ keybindLabel }}</button></div>
          <div class="row"><label></label><span class="hint">支持键盘键（F1–F12、Ctrl 组合键等）与鼠标侧键（XButton1 / XButton2）。</span></div>
          <div class="row"><label></label><button class="btn primary" @click="saveKeybind">保存按键</button></div>
        </div>
        <div class="group">
          <div class="group-h">扫描模式</div>
          <div class="row"><label>模式</label><select class="inline-field" v-model="scanMode" @change="saveMode"><option value="manual">手动 · 按键触发</option><option value="automatic">自动 · 悬停触发</option></select></div>
          <div class="row"><label></label><span class="hint">手动：悬停物品后按扫描键查价。自动：悬停即查。</span></div>
        </div>
        <div class="group">
          <div class="group-h">悬浮窗外观</div>
          <div class="row"><label>弹出位置</label><select class="inline-field" v-model="alignment" @change="saveAlignment"><option value="attached">贴附物品旁</option><option value="top-left">左上角</option><option value="top-right">右上角</option><option value="bottom-left">左下角</option><option value="bottom-right">右下角</option></select></div>
          <div class="row"><label></label><span class="hint">更改后于下一次扫描生效。</span></div>
          <div class="row"><label>缩放</label><div class="range-wrap"><input type="range" min="0.6" max="2" step="0.1" :value="scale" @input="onScaleInput"><span class="range-val">{{ scaleVal }}</span></div></div>
        </div>
        <div class="group">
          <div class="group-h">OCR 服务</div>
          <div class="row"><label>状态</label><span class="ocr-line"><span class="ocr-dot" :class="ocrState"></span><span :style="{ color: ocrStatusColor }">{{ ocrStatusText }}</span></span></div>
          <div class="row"><label>汉化数据</label><span style="color:var(--ink-dim)">{{ mappingCount }}</span></div>
        </div>
      </div>

      <div class="pane" :class="{ active: pane === 'mapping' }">
        <div class="pane-title">数据汉化</div>
        <div class="pane-desc">管理中文 ↔ 英文翻译映射，提升识别准确度。</div>
        <div class="add-form">
          <input type="text" v-model="cnInput" placeholder="中文（如：长剑）">
          <input type="text" v-model="enInput" placeholder="英文（如：Longsword）">
          <button class="btn primary" @click="addMapping">添加</button>
        </div>
        <div class="status" :class="mappingStatus.type">{{ mappingStatus.text }}</div>
        <input type="text" class="search" v-model="search" placeholder="搜索汉化数据…">
        <div class="tab-bar">
          <div v-for="t in TABS" :key="t.key" class="tab" :class="{ active: currentTab === t.key }" @click="switchTab(t.key)">{{ t.label }} <span class="count">({{ counts[t.key] }})</span></div>
        </div>
        <div class="table-wrap"><div class="table-scroll">
          <table>
            <thead><tr><th>中文</th><th>英文</th><th>来源</th><th style="width:130px">操作</th></tr></thead>
            <tbody>
              <tr v-for="(entry, idx) in currentEntries" :key="idx">
                <template v-if="editingRow === idx">
                  <td><input class="edit-input" v-model="editingCn" autofocus @keyup.enter="saveEdit(idx)"></td>
                  <td><input class="edit-input" v-model="editingEn" @keyup.enter="saveEdit(idx)"></td>
                  <td class="src">{{ SRC[currentTab] }}</td>
                  <td><button class="btn primary sm" @click="saveEdit(idx)">保存</button> <button class="btn ghost sm" @click="cancelEdit">取消</button></td>
                </template>
                <template v-else>
                  <td class="cn">{{ entry.cn }}</td>
                  <td class="en">{{ entry.en }}</td>
                  <td class="src">{{ SRC[currentTab] }}</td>
                  <td><button class="btn ghost sm" @click="startEdit(idx)">编辑</button><button v-if="currentTab === 'custom'" class="btn danger sm" @click="removeMapping(idx)">删除</button></td>
                </template>
              </tr>
              <tr v-if="!currentEntries.length"><td colspan="4" class="empty">暂无汉化数据</td></tr>
            </tbody>
          </table>
        </div></div>
      </div>
    </div>
  </div>

  <div class="toast" :class="{ show: toastShow }">{{ toastMsg }}</div>
</template>
