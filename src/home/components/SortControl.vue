<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps ({
  charId: { type: String, default: '' },
  stashId: { type: String, default: '' },
  equipment: { type: Boolean, default: false },
  activeCharId: { type: String, default: '' },
  stackMode: { type: Boolean, default: true },
  includeInv: { type: Boolean, default: true },
  keepInPlace: { type: Boolean, default: true },
});
const emit = defineEmits ([ 'update:stackMode', 'update:includeInv', 'update:keepInPlace' ]);

const invoke = (ch, ...args) => window.electron.invoke (ch, ...args);

const sorting = ref (false);
const result = ref (null);
const error = ref ('');
const uipi = ref (null);
const sortSpeed = ref ('medium');
const sortPreset = ref ('default');
const sortHotkey = ref ('Ctrl+R');
const cancelHotkey = ref ('Ctrl+T');
const stashNextKey = ref ('Ctrl+E');
const crossHotkey = ref ('Ctrl+F12');
const listeningFor = ref (null);
const savedFlash = ref (null);
let savedFlashTimer = null;
const quickPlace = ref (true);

async function loadQuickPlace () {
  try {
    const r = await invoke ('dnd:quickplace-get');
    if (r && typeof r.enabled === 'boolean') quickPlace.value = r.enabled;
  } catch (e) {}
}

async function toggleQuickPlace () {
  const next = !quickPlace.value;
  try {
    const r = await invoke ('dnd:quickplace-set', next);
    if (r && typeof r.enabled === 'boolean') quickPlace.value = r.enabled;
    else quickPlace.value = next;
  } catch (e) { quickPlace.value = next; }
}

const SPEED_OPTIONS = [
  { id: 'slow', label: '慢', desc: '最稳，每步约 1.5s' },
  { id: 'relaxed', label: '较慢', desc: '较稳，每步约 0.8s' },
  { id: 'medium', label: '中', desc: '默认，兼顾稳定与速度' },
  { id: 'brisk', label: '较快', desc: '较快，约 3 倍提速' },
  { id: 'fast', label: '快速', desc: '快，约 9 倍提速，操作可靠' },
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

function startHotkeyListen (target) {
  listeningFor.value = target;
}
function stopHotkeyListen () { listeningFor.value = null; }
function cancelHotkeyListen () { listeningFor.value = null; }

function onHotkeyKeyDown (e) {
  const target = listeningFor.value;
  if (!target) return;
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
    stopHotkeyListen ();
    void saveHotkey (target, key);
  }
}

async function saveHotkey (target, key) {
  const field = target === 'sort' ? 'sort_hotkey' : target === 'cancel' ? 'cancel_hotkey' : target === 'stash' ? 'stash_next_key' : 'cross_hotkey';
  const r = await invoke ('settings:save', { [field]: key });
  if (r?.success) {
    if (target === 'sort') sortHotkey.value = key;
    else if (target === 'cancel') cancelHotkey.value = key;
    else if (target === 'stash') stashNextKey.value = key;
    else crossHotkey.value = key;
    savedFlash.value = target;
    clearTimeout (savedFlashTimer);
    savedFlashTimer = setTimeout (() => { savedFlash.value = null; }, 900);
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
    if (d?.cross_hotkey) crossHotkey.value = d.cross_hotkey;
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
  const speeds = { slow: 0.4, relaxed: 0.3, medium: 0.2, brisk: 0.1, fast: 0.02, instant: 0 };
  sortSpeed.value = id;
  try {
    const r = await invoke ('dnd:sort-speed-set', speeds[id]);
    if (!r?.success) sortSpeed.value = 'medium';
  } catch (e) {}
}

async function confirmCharacter () {
  const sid = parseInt (props.stashId) || 0;
  const isPersonal = sid < 20 || (sid >= 100 && sid <= 102);
  if (!isPersonal || !props.activeCharId || props.activeCharId === props.charId) return true;
  let liveName = props.activeCharId;
  let pickedName = props.charId;
  try {
    const d = await invoke ('dnd:characters');
    const list = d?.characters || [];
    liveName = list.find (c => c.id === props.activeCharId)?.nickname || liveName;
    pickedName = list.find (c => c.id === props.charId)?.nickname || pickedName;
  } catch (e) {}
  return window.confirm (
    `游戏内当前角色是「${liveName}」，你选择整理的是「${pickedName}」。\n` +
    '整理会操作游戏内当前打开的仓库界面，角色不一致会整理错仓库。\n' +
    '请先在游戏中切换到「' + pickedName + '」并打开它的仓库。\n\n仍要继续吗？'
  );
}

async function startSort () {
  if (!canStart.value) { error.value = '请选择角色和仓库'; return; }
  error.value = '';
  result.value = null;
  if (!(await confirmCharacter ())) return;
  sorting.value = true;
  kind.value = 'single';
  try {
    const r = await invoke ('dnd:sort-start', {
      character_id: props.charId,
      stash_id: String (props.stashId),
      stack_mode: props.stackMode,
      include_inventory: props.includeInv,
      keep_in_place: props.keepInPlace,
    });
    if (!r?.success) { error.value = r?.error || '启动失败'; sorting.value = false; }
  } catch (e) { error.value = '启动失败'; sorting.value = false; }
}

// ── 全仓库整理 / 跨仓库整理 ──
const kind = ref ('single');
const sortAllInfo = ref ({ total: 0, current: 0, label: '', results: [] });

// ── 跨仓整理配置 ──
const CATEGORY_LABELS = { Weapon: '武器', Armor: '护甲', Utility: '工具', Accessory: '饰品', Misc: '杂物', other: '其他' };
const MISC_LABELS = {
  gem: '宝石', ore: '矿石与金属', material: '材料',
  consumable: '消耗品', junk: '杂物',
};
const crossCfg = ref ({ categorize: true, categorize_mode: 'auto', category_map: {}, misc_map: {}, repack: false, repack_mode: 'front', evacuate: false, evacuate_stashes: [], arrange: true });
const miscOpen = ref (false);
const crossNote = ref ('');
const crossSteps = ref ([]);
const crossStepIndex = ref (0);
const crossStepLabel = ref ('');
const crossResults = ref ([]);
const stashOptions = ref ([]);

const crossPosition = computed ({
  get: () => crossCfg.value.categorize
    ? (crossCfg.value.categorize_mode === 'manual' ? 'category' : 'auto')
    : crossCfg.value.repack ? (crossCfg.value.repack_mode === 'balanced' ? 'balanced' : 'front') : 'auto',
  set: v => {
    crossCfg.value.categorize = v === 'category' || v === 'auto';
    crossCfg.value.categorize_mode = v === 'category' ? 'manual' : 'auto';
    crossCfg.value.repack = v === 'front' || v === 'balanced';
    if (crossCfg.value.repack) crossCfg.value.repack_mode = v;
  },
});

async function loadStashOptions () {
  if (!props.charId) { stashOptions.value = []; return; }
  try {
    const d = await invoke ('dnd:character', props.charId);
    const stashes = d?.stashes || {};
    stashOptions.value = Object.keys (stashes)
      .filter (id => !['2', '3'].includes (id))
      .map (id => ({ id, label: stashes[id].label || `仓库${id}` }));
    const cfg = crossCfg.value;
    const needDefault = Object.keys (CATEGORY_LABELS).every (t => !cfg.category_map[t]);
    if (needDefault && stashOptions.value.length) {
      const s = stashOptions.value;
      cfg.category_map = {
        Weapon: String (s[0]?.id ?? ''), Armor: String (s[0]?.id ?? ''),
        Utility: String (s[1]?.id ?? s[0]?.id ?? ''), Accessory: String (s[1]?.id ?? s[0]?.id ?? ''),
        Misc: String (s[2]?.id ?? s[0]?.id ?? ''), other: String (s[2]?.id ?? s[0]?.id ?? ''),
      };
    }
  } catch (e) {}
}

async function loadCrossConfig () {
  try {
    const d = await invoke ('settings:get');
    if (d && d.cross_config) {
      const merged = {
        categorize: true, categorize_mode: 'auto', category_map: {},
        misc_map: {}, repack: false, repack_mode: 'front', evacuate: false, evacuate_stashes: [], arrange: true,
        ...d.cross_config,
      };
      delete merged.merge;
      delete merged.clear_bag;
      if (!merged.categorize && !merged.repack) {
        merged.categorize = true;
        merged.categorize_mode = 'auto';
      }
      crossCfg.value = merged;
    }
  } catch (e) {}
}

let crossSaveTimer = null;
watch (crossCfg, () => {
  clearTimeout (crossSaveTimer);
  crossSaveTimer = setTimeout (() => {
    invoke ('settings:save', { cross_config: JSON.stringify (crossCfg.value) });
  }, 400);
}, { deep: true });

async function startCrossSort () {
  if (!props.charId) { crossNote.value = '请先在角色仓库页选择角色'; return; }
  if (!(await confirmCharacter ())) return;
  error.value = '';
  result.value = null;
  crossNote.value = '';
  sorting.value = true;
  kind.value = 'cross';
  crossResults.value = [];
  try {
    const cfg = JSON.parse (JSON.stringify (crossCfg.value));
    cfg.merge = props.stackMode;
    cfg.clear_bag = props.includeInv;
    const r = await invoke ('dnd:cross-sort-start', { character_id: props.charId, config: cfg });
    if (!r?.success) {
      error.value = r?.error || ('启动失败：' + JSON.stringify (r));
      sorting.value = false;
    }
  } catch (e) {
    error.value = '启动失败：' + String (e);
    sorting.value = false;
  }
}

async function startSortAll () {
  if (!props.charId) { error.value = '请先在角色仓库页选择角色'; return; }
  error.value = '';
  result.value = null;
  if (!(await confirmCharacter ())) return;
  sorting.value = true;
  kind.value = 'all';
  sortAllInfo.value = { total: 0, current: 0, label: '', results: [] };
  try {
    const r = await invoke ('dnd:sort-all-start', { character_id: props.charId });
    if (!r?.success) { error.value = r?.error || '启动失败'; sorting.value = false; }
  } catch (e) { error.value = '启动失败'; sorting.value = false; }
}

async function startMergeStacks () {
  if (!props.charId) { error.value = '请先在角色仓库页选择角色'; return; }
  error.value = '';
  result.value = null;
  sorting.value = true;
  kind.value = 'merge';
  try {
    const r = await invoke ('dnd:merge-stacks-start', { character_id: props.charId });
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
    if (s) {
      if (s.kind) kind.value = s.kind;
      sortAllInfo.value = {
        total: s.sort_all_total || 0,
        current: s.sort_all_current || 0,
        label: s.sort_all_label || '',
        results: s.sort_all_results || [],
      };
      crossSteps.value = s.cross_steps || [];
      crossStepIndex.value = s.cross_step_index || 0;
      crossStepLabel.value = s.cross_step_label || '';
      crossResults.value = s.cross_results || [];
    }
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

let unsubs = [];
onMounted (async () => {
  checkUipi ();
  loadSortSpeed ();
  loadSortOrder ();
  loadHotkeys ();
  loadCrossConfig ();
  loadStashOptions ();
  loadQuickPlace ();
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
  if (crossSaveTimer) clearTimeout (crossSaveTimer);
  if (savedFlashTimer) clearTimeout (savedFlashTimer);
  document.removeEventListener ('keydown', onHotkeyKeyDown);
  unsubs.forEach (u => u ());
  unsubs = [];
});

watch (() => props.charId, () => loadStashOptions ());
</script>

<template>
  <div>
    <div class="page-title">配置</div>
    <div class="page-sub"><b>请先在游戏中打开要整理的仓库界面</b>（能看到物品格子），再开始整理；整理期间保持游戏窗口在前台。</div>

    <div v-if="uipiBlocked" class="uipi-warn">
      <b>鼠标模拟将被系统拦截</b>
      <span>检测到游戏以<b>管理员权限</b>运行，而 冒险者侍从 不是。Windows 会拦截整理时的鼠标操作（游戏内光标不会移动）。请<b>以管理员身份运行 冒险者侍从</b>（右键快捷方式 → 以管理员身份运行），或取消游戏快捷方式的"以管理员身份运行"后重试。</span>
    </div>

    <div class="sec">
      <div class="sec-label">整理选项</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">排序方案</div>
            <div class="srow-d">决定物品摆放顺序，可随时切换</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in SORT_PRESETS" :key="o.id"
                      class="seg-opt" :class="{ on: sortPreset === o.id }"
                      @click="changePreset(o.id)">
                <span class="seg-t">{{ o.label }}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="srow speed-row">
          <div class="srow-info">
            <div class="srow-t">整理速度</div>
            <div class="srow-d">极速≈10 倍提速；漏放/串位请用中或慢</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in SPEED_OPTIONS" :key="o.id"
                      class="seg-opt" :class="{ on: sortSpeed === o.id }"
                      @click="changeSpeed(o.id)">
                <span class="seg-t">{{ o.label }}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">游戏仓库跟随</div>
            <div class="srow-d">游戏内切仓时自动识别跟随</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in FOLLOW_OPTIONS" :key="o.id"
                      class="seg-opt" :class="{ on: followMode === o.id }"
                      @click="changeFollowMode(o.id)">
                <span class="seg-t">{{ o.label }}</span>
              </button>
            </div>
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
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">保留相同物品原位</div>
            <div class="srow-d">原位不动，减少拖动；关闭则彻底重排</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" :checked="props.keepInPlace" @change="emit('update:keepInPlace', $event.target.checked)"><span class="track"></span></label>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">快速放置（Shift+右键）</div>
            <div class="srow-d">快速放置更快；落点不符自动退回拖动</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" :checked="quickPlace" @change="toggleQuickPlace()"><span class="track"></span></label>
          </div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">仓库整理</div>
      <div class="card run-card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">开始整理</div>
            <div class="srow-d">单仓库整理选中仓库；全仓按标签顺序逐个整理全部仓库</div>
          </div>
          <div class="srow-ctl">
            <template v-if="sorting">
              <span class="run-inline">
                <span class="spin"></span>
                <template v-if="kind === 'all'"><b>{{ sortAllInfo.current }}/{{ sortAllInfo.total }}</b> · {{ sortAllInfo.label }}</template>
                <template v-else>整理中…</template>
              </span>
              <button class="btn danger" @click="cancelSort">取消</button>
            </template>
            <template v-else>
              <button class="btn primary" :disabled="!canStart" @click="startSort">单仓库整理</button>
              <button class="btn primary" :disabled="!props.charId" @click="startSortAll">全仓库整理</button>
            </template>
          </div>
        </div>

        <div v-if="error" class="status error">{{ error }}</div>
        <div v-if="result" class="status" :class="result.success ? 'success' : 'error'">{{ result.message }}</div>
        <div v-if="sortAllInfo.results.length" class="sort-all-results">
          <div v-for="r in sortAllInfo.results" :key="r.stash_id" class="sar-row" :class="r.success ? 'ok' : 'bad'">
            <span class="sar-name">{{ r.label }}</span>
            <span class="sar-msg">{{ r.success ? '✓' : '✗' }} {{ r.message }}</span>
          </div>
        </div>

        <div class="run-keys">
          <div class="srow">
            <div class="srow-info">
              <div class="srow-t">开始整理键</div>
              <div class="srow-d">单仓库整理的全局快捷键，支持 F1–F12 及 Ctrl/Alt/Shift 组合</div>
            </div>
            <div class="srow-ctl">
              <button class="hotkey-cap" :class="{ listening: listeningFor === 'sort', saved: savedFlash === 'sort' }"
                      @click="startHotkeyListen('sort')" :title="listeningFor === 'sort' ? '按 Esc 取消' : '点击修改'">
                {{ listeningFor === 'sort' ? '按新键… Esc 取消' : sortHotkey }}
              </button>
            </div>
          </div>
          <div class="srow">
            <div class="srow-info">
              <div class="srow-t">取消整理键</div>
              <div class="srow-d">全局快捷键，随时中断整理</div>
            </div>
            <div class="srow-ctl">
              <button class="hotkey-cap" :class="{ listening: listeningFor === 'cancel', saved: savedFlash === 'cancel' }"
                      @click="startHotkeyListen('cancel')" :title="listeningFor === 'cancel' ? '按 Esc 取消' : '点击修改'">
                {{ listeningFor === 'cancel' ? '按新键… Esc 取消' : cancelHotkey }}
              </button>
            </div>
          </div>
          <div class="srow">
            <div class="srow-info">
              <div class="srow-t">仓库切换键</div>
              <div class="srow-d">全局快捷键，循环切换下一个仓库</div>
            </div>
            <div class="srow-ctl">
              <button class="hotkey-cap" :class="{ listening: listeningFor === 'stash', saved: savedFlash === 'stash' }"
                      @click="startHotkeyListen('stash')" :title="listeningFor === 'stash' ? '按 Esc 取消' : '点击修改'">
                {{ listeningFor === 'stash' ? '按新键… Esc 取消' : stashNextKey }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">跨仓整理</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">开始跨仓整理</div>
            <div class="srow-d">按下方位置策略执行跨仓整理</div>
          </div>
          <div class="srow-ctl">
            <button v-if="!(sorting && kind === 'cross')" class="btn primary" :disabled="!props.charId || sorting" @click="startCrossSort">开始跨仓整理</button>
            <button v-else class="btn danger" @click="cancelSort">取消整理</button>
            <span v-if="crossNote" class="cal-note">{{ crossNote }}</span>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">跨仓整理快捷键</div>
            <div class="srow-d">全局快捷键，点击键帽可改</div>
          </div>
          <div class="srow-ctl">
            <button class="hotkey-cap" :class="{ listening: listeningFor === 'cross', saved: savedFlash === 'cross' }"
                    @click="startHotkeyListen('cross')" :title="listeningFor === 'cross' ? '按 Esc 取消' : '点击修改'">
              {{ listeningFor === 'cross' ? '按新键… Esc 取消' : crossHotkey }}
            </button>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">位置策略</div>
            <div class="srow-d">物品摆放规则（归类与重排互斥）</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button class="seg-opt" :class="{ on: crossPosition === 'auto' }" @click="crossPosition = 'auto'"><span class="seg-t">自动归类</span></button>
              <button class="seg-opt" :class="{ on: crossPosition === 'category' }" @click="crossPosition = 'category'"><span class="seg-t">手动定义</span></button>
              <button class="seg-opt" :class="{ on: crossPosition === 'front' }" @click="crossPosition = 'front'"><span class="seg-t">密集整理</span></button>
              <button class="seg-opt" :class="{ on: crossPosition === 'balanced' }" @click="crossPosition = 'balanced'"><span class="seg-t">均衡分散</span></button>
            </div>
          </div>
        </div>
        <template v-if="crossCfg.categorize && crossCfg.categorize_mode === 'manual'">
          <div class="cat-grid">
            <label v-for="(label, type) in CATEGORY_LABELS" :key="type" class="cat-cell">
              <span class="cat-name">{{ label }}</span>
              <select class="cross-select" v-model="crossCfg.category_map[type]">
                <option v-for="s in stashOptions" :key="s.id" :value="String(s.id)">{{ s.label }}</option>
              </select>
            </label>
          </div>
          <div class="srow cal-toggle" @click="miscOpen = !miscOpen">
            <div class="srow-info">
              <div class="srow-t">杂物细分（宝石 / 材料 / 消耗品）</div>
              <div class="srow-d">杂物按子类指定仓库，优先于大类{{ miscOpen ? '' : ' —— 点击展开' }}</div>
            </div>
            <div class="srow-ctl">
              <span class="cal-arrow" :class="{ open: miscOpen }">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </span>
            </div>
          </div>
          <div v-if="miscOpen" class="cat-grid">
            <label v-for="(label, type) in MISC_LABELS" :key="'m' + type" class="cat-cell">
              <span class="cat-name">{{ label }}</span>
              <select class="cross-select" v-model="crossCfg.misc_map[type]">
                <option value="">沿用大类</option>
                <option v-for="s in stashOptions" :key="s.id" :value="String(s.id)">{{ s.label }}</option>
              </select>
            </label>
          </div>
        </template>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">仓内整理</div>
            <div class="srow-d">最后做各仓库内部摆放优化</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" v-model="crossCfg.arrange"><span class="track"></span></label>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">腾空仓库</div>
            <div class="srow-d">清空勾选的仓库，物品搬到其他仓库</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" v-model="crossCfg.evacuate"><span class="track"></span></label>
          </div>
        </div>
        <template v-if="crossCfg.evacuate">
          <div class="srow" v-for="s in stashOptions" :key="'e' + s.id">
            <div class="srow-info">
              <div class="srow-t">{{ s.label }}</div>
              <div class="srow-d">整理后该仓库将被清空</div>
            </div>
            <div class="srow-ctl">
            <label class="switch"><input type="checkbox" :value="String(s.id)" v-model="crossCfg.evacuate_stashes"><span class="track"></span></label>
          </div>
        </div>
        </template>
        <div v-if="kind === 'cross' && sorting" class="run-progress">
          <span class="spin"></span>
          <span>跨仓整理：<b>{{ crossStepIndex }}/{{ crossSteps.length }}</b> · {{ crossStepLabel }}</span>
        </div>
        <div v-if="kind === 'cross' && error" class="status error">{{ error }}</div>
        <div v-if="kind === 'cross' && result" class="status" :class="result.success ? 'success' : 'error'">{{ result.message }}</div>
        <div v-if="crossResults.length" class="sort-all-results">
          <div v-for="(r, i) in crossResults" :key="i" class="sar-row" :class="r.ok ? 'ok' : 'bad'">
            <span class="sar-name">{{ r.step }}</span>
            <span class="sar-msg">{{ r.ok ? '✓' : '✗' }} {{ r.detail }}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.run-card { padding: 16px 18px; }
.run-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.run-btns { display: flex; gap: 8px; }
.run-hints { display: flex; gap: 18px; }
.hint { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-3); }
.btn.lg { padding: 9px 24px; font-size: 14px; }
.btn:disabled { opacity: .45; cursor: default; transform: none; }
.run-keys { margin-top: 4px; }
.sort-all-results { margin-top: 12px; border-top: 1px solid var(--line-soft); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.sar-row {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; font-size: 12.5px;
  border-radius: 8px; border: 1px solid var(--line-soft);
  background: var(--card-2);
}
.sar-row.ok { background: var(--green-soft); border-color: var(--green); }
.sar-row.bad { background: var(--red-soft); border-color: var(--red); }
.sar-name { min-width: 96px; font-weight: 650; color: var(--text); }
.sar-msg { flex: 1; word-break: break-word; color: var(--text-2); }
.sar-row.ok .sar-msg { color: var(--green); }
.sar-row.bad .sar-msg { color: var(--red); }
.cal-note { font-size: 12.5px; color: var(--green); }
.cat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 14px;
  padding: 10px 18px 14px;
  background: var(--card-2);
  border-top: 1px solid var(--line-soft);
}
.cat-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cat-name { font-size: 11.5px; font-weight: 650; color: var(--text-2); }
.cross-select {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--line); border-radius: 7px;
  background: var(--card); color: var(--text-2);
  font-size: 12px; font-family: var(--font);
  cursor: pointer; outline: none;
}
.cross-select:hover { border-color: var(--accent-soft); }
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

.run-inline { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); white-space: nowrap; }
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
