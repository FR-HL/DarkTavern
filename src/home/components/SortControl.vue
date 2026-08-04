<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps ({
  charId: { type: String, default: '' },
  stashId: { type: String, default: '' },
  equipment: { type: Boolean, default: false },
  activeCharId: { type: String, default: '' },
  packMode: { type: Boolean, default: true },
  stackMode: { type: Boolean, default: true },
  includeInv: { type: Boolean, default: true },
});
const emit = defineEmits ([ 'update:packMode', 'update:stackMode', 'update:includeInv' ]);

const invoke = (ch, d) => window.electron.invoke (ch, d);

const sorting = ref (false);
const result = ref (null);
const error = ref ('');
const uipi = ref (null);
const sortSpeed = ref ('medium');
const sortPreset = ref ('default');
const sortHotkey = ref ('Ctrl+R');
const cancelHotkey = ref ('Ctrl+T');
const stashNextKey = ref ('Ctrl+E');
const listeningFor = ref (null);
const newHotkey = ref (null);

const SPEED_OPTIONS = [
  { id: 'slow', label: '慢', desc: '最稳，每步约 1.5s' },
  { id: 'medium', label: '中', desc: '默认，兼顾稳定与速度' },
  { id: 'instant', label: '极速', desc: '最快，约 10 倍提速，偶发漏操作' },
];

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

const RESERVED_HOTKEYS = ['F5', 'F6', 'F7', 'F8'];

const uipiBlocked = computed (() => !!(uipi.value && uipi.value.blocked));

const canStart = computed (() =>
  !!props.charId && props.stashId !== '' && !props.equipment && !sorting.value && !uipiBlocked.value);

function hotkeyLabel (target) {
  if (listeningFor.value === target) return '等待输入…（按 Esc 取消）';
  return newHotkey.value || '点击此处，然后按下新按键';
}

function startHotkeyListen (target) {
  listeningFor.value = target;
  newHotkey.value = null;
}
function stopHotkeyListen () { listeningFor.value = null; }
function cancelHotkeyListen () { listeningFor.value = null; newHotkey.value = null; }

function onHotkeyKeyDown (e) {
  if (!listeningFor.value) return;
  e.preventDefault ();
  if (e.key === 'Escape') { cancelHotkeyListen (); return; }
  if (RESERVED_HOTKEYS.includes (e.key)) return;
  let key = '';
  if (e.ctrlKey) key += 'Ctrl+';
  if (e.altKey) key += 'Alt+';
  if (e.shiftKey) key += 'Shift+';
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return;
  const base = e.key.length === 1 ? e.key.toUpperCase () : e.key;
  key += base;
  if (['F1', 'F2', 'F3', 'F4', 'F9', 'F10', 'F11', 'F12', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes (base) || key.includes ('+')) {
    newHotkey.value = key;
    stopHotkeyListen ();
  }
}

async function saveHotkey (target) {
  if (!newHotkey.value) return;
  const field = target === 'sort' ? 'sort_hotkey' : target === 'cancel' ? 'cancel_hotkey' : 'stash_next_key';
  const r = await invoke ('settings:save', { [field]: newHotkey.value });
  if (r?.success) {
    if (target === 'sort') sortHotkey.value = newHotkey.value;
    else if (target === 'cancel') cancelHotkey.value = newHotkey.value;
    else stashNextKey.value = newHotkey.value;
    newHotkey.value = null;
  }
}

async function checkUipi () {
  try {
    uipi.value = await invoke ('dnd:sort-uipi');
  } catch (e) { uipi.value = null; }
}

async function loadSortSpeed () {
  try {
    const s = await invoke ('dnd:sort-speed-get');
    if (s && s.preset) sortSpeed.value = s.preset;
  } catch (e) {}
}

async function loadHotkeys () {
  try {
    const d = await invoke ('settings:get');
    if (d?.sort_hotkey) sortHotkey.value = d.sort_hotkey;
    if (d?.cancel_hotkey) cancelHotkey.value = d.cancel_hotkey;
    if (d?.stash_next_key) stashNextKey.value = d.stash_next_key;
    if (d?.follow_mode) followMode.value = d.follow_mode;
  } catch (e) {}
}

// ── 仓库跟随模式（关闭 / 点击识别 / 像素识别） ──
const followMode = ref ('click');
const FOLLOW_OPTIONS = [
  { id: 'off', label: '关闭', desc: '不跟随' },
  { id: 'click', label: '点击识别', desc: '鼠标钩子 · 即时' },
  { id: 'pixel', label: '像素识别', desc: '像素扫描 · 手柄可用' },
];

async function changeFollowMode (id) {
  followMode.value = id;
  await invoke ('settings:save', { follow_mode: id });
}

// ── 仓库标签校准（可折叠） ──
const calExpand = ref (false);

// ── 跟随校准（像素识别用，逐 Tab 记录选中态特征） ──
const fCalItems = ref ([]);
const fCalPending = ref ([]);
const autoCalBusy = ref (false);

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

async function changeSpeed (id) {
  const opt = SPEED_OPTIONS.find (o => o.id === id);
  if (!opt) return;
  const speeds = { slow: 0.4, medium: 0.2, instant: 0 };
  sortSpeed.value = id;
  try {
    const r = await invoke ('dnd:sort-speed-set', speeds[id]);
    if (!r?.success) sortSpeed.value = 'medium';
  } catch (e) {}
}

async function startSort () {
  if (!canStart.value) { error.value = '请选择角色和仓库'; return; }
  error.value = '';
  result.value = null;
  const sid = parseInt (props.stashId) || 0;
  const isPersonal = sid < 20 || (sid >= 100 && sid <= 102);
  if (isPersonal && props.activeCharId && props.activeCharId !== props.charId) {
    let liveName = props.activeCharId;
    let pickedName = props.charId;
    try {
      const d = await invoke ('dnd:characters');
      const list = d?.characters || [];
      liveName = list.find (c => c.id === props.activeCharId)?.nickname || liveName;
      pickedName = list.find (c => c.id === props.charId)?.nickname || pickedName;
    } catch (e) {}
    const ok = window.confirm (
      `游戏内当前角色是「${liveName}」，你选择整理的是「${pickedName}」。\n` +
      '整理会操作游戏内当前打开的仓库界面，角色不一致会整理错仓库。\n' +
      '请先在游戏中切换到「' + pickedName + '」并打开它的仓库。\n\n仍要继续吗？'
    );
    if (!ok) return;
  }
  sorting.value = true;
  try {
    const r = await invoke ('dnd:sort-start', {
      character_id: props.charId,
      stash_id: String (props.stashId),
      pack_mode: props.packMode,
      stack_mode: props.stackMode,
      include_inventory: props.includeInv,
    });
    if (!r?.success) { error.value = r?.error || '启动失败'; sorting.value = false; }
  } catch (e) { error.value = '启动失败'; sorting.value = false; }
}

async function cancelSort () {
  await invoke ('dnd:sort-cancel');
}

let poll = null;
async function pollStatus () {
  if (!sorting.value) return;
  try {
    const s = await invoke ('dnd:sort-status');
    if (s && !s.running) {
      sorting.value = false;
      result.value = s.result;
      if (s.error) error.value = s.error;
    }
  } catch (e) {}
}

function onSortStarted () {
  sorting.value = true;
  error.value = '';
  result.value = null;
}
function onSortCancelled () {
  sorting.value = false;
}

// ── 仓库标签校准 ──
const calItems = ref ([]);
const calPending = ref ([]);
const calSaving = ref (false);
const calNote = ref ('');

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

let unsubs = [];
onMounted (async () => {
  checkUipi ();
  loadSortSpeed ();
  loadSortOrder ();
  loadHotkeys ();
  loadCalibration ();
  loadFollowCal ();
  try {
    const s = await invoke ('dnd:sort-status');
    if (s && s.running) sorting.value = true;
  } catch (e) {}
  document.addEventListener ('keydown', onHotkeyKeyDown);
  unsubs = [
    window.electron.on ('dnd:sort-started', onSortStarted),
    window.electron.on ('dnd:sort-cancelled', onSortCancelled),
  ];
  poll = setInterval (pollStatus, 1000);
});

onBeforeUnmount (() => {
  if (poll) clearInterval (poll);
  document.removeEventListener ('keydown', onHotkeyKeyDown);
  unsubs.forEach (u => u ());
  unsubs = [];
});
</script>

<template>
  <div>
    <div class="page-title">配置</div>
    <div class="page-sub"><b>请先在游戏中打开要整理的仓库界面</b>（能看到物品格子），再开始整理；整理期间保持游戏窗口在前台。</div>

    <div v-if="uipiBlocked" class="uipi-warn">
      <b>鼠标模拟将被系统拦截</b>
      <span>检测到游戏以<b>管理员权限</b>运行，而 DarkTavern 不是。Windows 会拦截整理时的鼠标操作（游戏内光标不会移动）。请<b>以管理员身份运行 DarkTavern</b>（右键快捷方式 → 以管理员身份运行），或取消游戏快捷方式的"以管理员身份运行"后重试。</span>
    </div>

    <div class="sec">
      <div class="sec-label">整理选项</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">排序方案</div>
            <div class="srow-d">决定物品的摆放顺序；可随时切换，重启后保留</div>
          </div>
          <div class="srow-ctl preset-group">
            <button v-for="o in SORT_PRESETS" :key="o.id"
                    class="speed-opt" :class="{ active: sortPreset === o.id }"
                    @click="changePreset(o.id)">
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="srow speed-row">
          <div class="srow-info">
            <div class="srow-t">整理速度</div>
            <div class="srow-d">极速≈10 倍提速；若出现漏放/串位，改用中或慢</div>
          </div>
          <div class="srow-ctl speed-group">
            <button v-for="o in SPEED_OPTIONS" :key="o.id"
                    class="speed-opt" :class="{ active: sortSpeed === o.id }"
                    @click="changeSpeed(o.id)">
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">紧凑模式</div>
            <div class="srow-d">优先把物品摆放得更紧密</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" :checked="props.packMode" @change="emit('update:packMode', $event.target.checked)"><span class="track"></span></label>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">堆叠模式</div>
            <div class="srow-d">先合并可堆叠物品再整理</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" :checked="props.stackMode" @change="emit('update:stackMode', $event.target.checked)"><span class="track"></span></label>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">包含背包物品</div>
            <div class="srow-d">把背包中的物品一并放入仓库</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" :checked="props.includeInv" @change="emit('update:includeInv', $event.target.checked)"><span class="track"></span></label>
          </div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">执行</div>
      <div class="card run-card">
        <div class="run-row">
          <div class="run-hints">
            <span class="hint"><span class="kbd">{{ sortHotkey }}</span> 开始整理</span>
            <span class="hint"><span class="kbd">{{ cancelHotkey }}</span> 取消整理</span>
            <span class="hint"><span class="kbd">{{ stashNextKey }}</span> 切换仓库</span>
          </div>
          <button v-if="!sorting" class="btn primary lg" :disabled="!canStart" @click="startSort">开始整理</button>
          <button v-else class="btn danger lg" @click="cancelSort">取消整理</button>
        </div>

        <div class="run-keys">
          <div class="srow">
            <div class="srow-info">
              <div class="srow-t">开始整理键</div>
              <div class="srow-d">全局快捷键，支持 F1–F12 及 Ctrl/Alt/Shift 组合</div>
            </div>
            <div class="srow-ctl">
              <span class="kbd">{{ sortHotkey }}</span>
              <button class="keybind-btn" :class="{ listening: listeningFor === 'sort' }" @click="startHotkeyListen('sort')">{{ hotkeyLabel('sort') }}</button>
              <button class="btn primary" @click="saveHotkey('sort')">保存</button>
            </div>
          </div>
          <div class="srow">
            <div class="srow-info">
              <div class="srow-t">取消整理键</div>
              <div class="srow-d">全局快捷键，随时中断整理</div>
            </div>
            <div class="srow-ctl">
              <span class="kbd">{{ cancelHotkey }}</span>
              <button class="keybind-btn" :class="{ listening: listeningFor === 'cancel' }" @click="startHotkeyListen('cancel')">{{ hotkeyLabel('cancel') }}</button>
              <button class="btn primary" @click="saveHotkey('cancel')">保存</button>
            </div>
          </div>
          <div class="srow">
            <div class="srow-info">
              <div class="srow-t">仓库切换键</div>
              <div class="srow-d">全局快捷键，在仓库列表中循环切换下一个仓库</div>
            </div>
            <div class="srow-ctl">
              <span class="kbd">{{ stashNextKey }}</span>
              <button class="keybind-btn" :class="{ listening: listeningFor === 'stash' }" @click="startHotkeyListen('stash')">{{ hotkeyLabel('stash') }}</button>
              <button class="btn primary" @click="saveHotkey('stash')">保存</button>
            </div>
          </div>
        </div>

        <div v-if="sorting" class="run-progress">
          <span class="spin"></span>
          <span>整理进行中——请保持 <b>Dark and Darker</b> 窗口在前台，不要移动鼠标。</span>
        </div>

        <div v-if="error" class="status error">{{ error }}</div>
        <div v-if="result" class="status" :class="result.success ? 'success' : 'error'">
          {{ result.success ? '整理完成' : '整理未完成' }}<template v-if="result.message">：{{ result.message }}</template>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">仓库跟随</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">跟随模式</div>
            <div class="srow-d">游戏内切换仓库时，软件自动识别并跟随当前仓库</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in FOLLOW_OPTIONS" :key="o.id"
                      class="seg-opt" :class="{ on: followMode === o.id }"
                      @click="changeFollowMode(o.id)">
                <span class="seg-t">{{ o.label }}</span>
                <span class="seg-d">{{ o.desc }}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="srow cal-toggle" @click="calExpand = !calExpand">
          <div class="srow-info">
            <div class="srow-t">仓库标签校准</div>
            <div class="srow-d" v-if="followMode === 'pixel'">点击坐标（切换/整理用）+ 选中态特征（像素识别用）{{ calExpand ? '' : ' —— 点击展开' }}</div>
            <div class="srow-d" v-else>点击坐标（游戏内切换、整理自动选 Tab 用）{{ calExpand ? '' : ' —— 点击展开' }}</div>
          </div>
          <div class="srow-ctl">
            <span class="cal-arrow" :class="{ open: calExpand }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </span>
          </div>
        </div>

        <template v-if="calExpand">
          <div class="term-body">
            <p v-if="followMode === 'pixel'">手动：<b>先在游戏中点击该仓库标签</b>，再回来点「记录」——一次同时记录坐标与特征；也可用「一键自动校准」自动采集特征。</p>
            <p v-else>手动：<b>先在游戏中点击该仓库标签</b>，再回来点「记录」记录其坐标（坐标校准需手动完成，程序无法得知游戏内标签的真实位置）。</p>
          </div>
          <div v-if="followMode === 'pixel'" class="srow">
            <div class="srow-info">
              <div class="srow-t">一键自动校准</div>
              <div class="srow-d">程序自动依次点击游戏里的每个标签并采样选中态特征，约 8 秒完成，请先打开游戏仓库界面</div>
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
              <div class="srow-d" v-if="followMode === 'pixel'">全部记录后保存生效；清除后回退到内置坐标与亮度阈值识别</div>
              <div class="srow-d" v-else>全部记录后保存生效；清除后回退到内置坐标</div>
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
              <div class="srow-d">自动依次点击游戏里的每个标签，核对实际切换顺序</div>
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
    </div>
  </div>
</template>

<style scoped>
.run-card { padding: 16px 18px; }
.run-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.run-hints { display: flex; gap: 18px; }
.hint { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-3); }
.btn.lg { padding: 9px 24px; font-size: 14px; }
.btn:disabled { opacity: .45; cursor: default; transform: none; }
.run-keys { margin-top: 4px; }
.cal-note { font-size: 12.5px; color: var(--green); }
.cal-sep { margin: 0 6px; color: var(--line); }
.cal-toggle { cursor: pointer; user-select: none; }
.cal-toggle:hover .srow-t { color: var(--accent); }
.cal-arrow {
  display: inline-flex; align-items: center;
  color: var(--text-3);
  transition: transform .22s var(--ease);
}
.cal-arrow svg { width: 15px; height: 15px; }
.cal-arrow.open { transform: rotate(180deg); color: var(--accent); }

.uipi-warn {
  display: flex; flex-direction: column; gap: 6px;
  margin-bottom: 14px; padding: 13px 15px;
  background: #fff4e5; border: 1px solid #f0c97e;
  border-radius: 10px;
  font-size: 13px; color: #7a4d0d; line-height: 1.6;
}
.uipi-warn b { font-weight: 650; color: #a05a00; }

.speed-group { display: flex; gap: 6px; }
.speed-row .srow-info { flex: 0 0 300px; }
.speed-opt {
  padding: 6px 16px; font-size: 13px; font-weight: 600;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--card-2); color: var(--text-2);
  cursor: pointer; transition: all .15s;
}
.speed-opt:hover { border-color: var(--accent-soft); }
.speed-opt.active {
  background: var(--accent); border-color: var(--accent);
  color: #fff; box-shadow: 0 2px 8px rgba(0,113,227,0.28);
}

.run-progress {
  display: flex; align-items: center; gap: 12px;
  margin-top: 15px; padding: 13px 15px;
  background: var(--accent-softer); border: 1px solid rgba(0,113,227,0.22);
  border-radius: 10px;
  font-size: 13px; color: var(--text-2); line-height: 1.5;
}
.run-progress b { color: var(--accent); font-weight: 650; }
.spin {
  width: 16px; height: 16px; flex: none;
  border: 2.5px solid var(--accent-soft); border-top-color: var(--accent);
  border-radius: 50%; animation: rot .8s linear infinite;
}
@keyframes rot { to { transform: rotate(360deg); } }

html[data-theme="dark"] .uipi-warn {
  background: #3a2c14;
  border-color: rgba(240,201,126,0.3);
  color: #e8c87a;
}
html[data-theme="dark"] .uipi-warn b { color: #f2c14e; }
</style>
