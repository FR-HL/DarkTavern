<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';

const invoke = (ch, d) => window.electron.invoke (ch, d);

const characters = ref ([]);
const charId = ref ('');
const stashes = ref ([]);
const stashId = ref ('');
const packMode = ref (true);
const stackMode = ref (true);
const includeInv = ref (true);
const sorting = ref (false);
const result = ref (null);
const error = ref ('');
const uipi = ref (null);
const sortSpeed = ref ('medium');
// Character currently being played in-game (latest snapshot via WebSocket).
const activeCharacterId = ref ('');
// OCR service port, used to build icon URLs.
const servicePort = ref (19528);
const SPEED_OPTIONS = [
  { id: 'slow', label: '慢', desc: '最稳，每步约 1.5s' },
  { id: 'medium', label: '中', desc: '默认，兼顾稳定与速度' },
  { id: 'instant', label: '极速', desc: '最快，约 10 倍提速，偶发漏操作' },
];

const SORT_PRESETS = [
  {
    id: 'default', label: '默认整理',
    order: [
      { field: 'name', direction: 'asc' },
      { field: 'width', direction: 'desc' }, { field: 'height', direction: 'desc' },
      { field: 'slot', direction: 'desc' }, { field: 'rarity', direction: 'desc' },
    ],
  },
  {
    id: 'category', label: '类别分区',
    groupMode: 'category',
    order: [
      { field: 'name', direction: 'asc' },
      { field: 'width', direction: 'desc' }, { field: 'height', direction: 'desc' },
      { field: 'rarity', direction: 'desc' },
    ],
  },
];
const sortPreset = ref ('default');

const SORT_HOTKEY = 'Ctrl+F11';
const CANCEL_HOTKEY = 'Ctrl+F12';

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

const selected = ref (null);
const charData = ref (null);
const loading = ref (false);

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
  stashList.value.find (s => s.id === stashId.value) || null
);

const isEquipment = computed (() => !!currentStash.value && currentStash.value.layout === 'equipment');

function slotStyle (s) {
  return {
    left: s.x * (CELL + GAP) + 'px',
    top: s.y * (CELL + GAP) + 'px',
    width: s.w * CELL + (s.w - 1) * GAP + 'px',
    height: s.h * CELL + (s.h - 1) * GAP + 'px',
  };
}

const totalItems = computed (() =>
  currentStash.value ? currentStash.value.items.length : 0
);

const usedCells = computed (() => {
  if (!currentStash.value) return 0;
  return currentStash.value.items.reduce ((n, it) => n + it.width * it.height, 0);
});

const fillPct = computed (() => {
  const s = currentStash.value;
  if (!s) return 0;
  return Math.min (100, Math.round (usedCells.value / (s.width * s.height) * 100));
});

const CELL = 34, GAP = 2;
const bgCells = computed (() => {
  const s = currentStash.value;
  return s ? s.width * s.height : 0;
});

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

async function loadCharData (id, silent = false) {
  if (!silent) { loading.value = true; error.value = ''; charData.value = null; }
  try {
    const d = await invoke ('dnd:character', id);
    if (d && !d.error) {
      charData.value = d;
      if (!stashList.value.some (s => s.id === stashId.value)) {
        stashId.value = '';
        const first = stashList.value[0];
        if (first) stashId.value = first.id;
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
  charId.value = id;
  await loadCharData (id);
}

async function reloadCharacters () {
  selected.value = null;
  charData.value = null;
  charId.value = '';
  stashId.value = '';
  await loadCharacters ();
}

const onCharactersRefresh = () => reloadCharacters ();

const canStart = computed (() =>
  !!charId.value && stashId.value !== '' && !isEquipment.value && !sorting.value && !uipiBlocked.value);

const uipiBlocked = computed (() => !!(uipi.value && uipi.value.blocked));

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

async function loadCharacters () {
  try {
    const d = await invoke ('dnd:characters');
    characters.value = d?.characters || [];
    if (characters.value.length && !charId.value) charId.value = characters.value[0].id;
  } catch (e) {}
}

async function loadStashes () {
  stashes.value = [];
  if (!charId.value) { stashId.value = ''; return; }
  try {
    const d = await invoke ('dnd:character', charId.value);
    if (d && d.stashes) {
      stashes.value = Object.entries (d.stashes)
        .map (([id, s]) => ({ id, label: s.label, count: s.items.length }))
        .sort ((a, b) => parseInt (a.id) - parseInt (b.id));
      if (!stashId.value) {
        // Default to the first non-empty standard stash, else the first.
        const preferred = stashes.value.find (s => s.count > 0 && parseInt (s.id) >= 4)
          || stashes.value.find (s => s.count > 0)
          || stashes.value[0];
        if (preferred) stashId.value = preferred.id;
      }
    }
  } catch (e) {}
}

watch (charId, loadStashes);

async function saveConfig () {
  try {
    await invoke ('dnd:sort-config-save', {
      character_id: charId.value,
      stash_id: stashId.value,
      pack_mode: packMode.value,
      stack_mode: stackMode.value,
      include_inventory: includeInv.value,
    });
  } catch (e) {}
}

watch ([charId, stashId, packMode, stackMode, includeInv], saveConfig);

async function restoreConfig () {
  try {
    const cfg = await invoke ('dnd:sort-config-get');
    if (!cfg) return;
    if (cfg.character_id && characters.value.some (c => c.id === cfg.character_id)) {
      charId.value = cfg.character_id;
      packMode.value = !!cfg.pack_mode;
      stackMode.value = !!cfg.stack_mode;
      includeInv.value = !!cfg.include_inventory;
      if (cfg.stash_id) {
        await loadStashes ();
        if (stashes.value.some (s => s.id === cfg.stash_id)) stashId.value = cfg.stash_id;
      }
    }
  } catch (e) {}
  if (charId.value) {
    selected.value = charId.value;
    await loadCharData (charId.value);
  }
}

async function startSort () {
  if (!canStart.value) { error.value = '请选择角色和仓库'; return; }
  error.value = '';
  result.value = null;
  const sid = parseInt (stashId.value) || 0;
  const isPersonal = sid < 20 || (sid >= 100 && sid <= 102);
  if (isPersonal && activeCharacterId.value && activeCharacterId.value !== charId.value) {
    const live = characters.value.find (c => c.id === activeCharacterId.value);
    const liveName = live?.nickname || activeCharacterId.value;
    const picked = characters.value.find (c => c.id === charId.value);
    const pickedName = picked?.nickname || charId.value;
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
      character_id: charId.value,
      stash_id: String (stashId.value),
      pack_mode: packMode.value,
      stack_mode: stackMode.value,
      include_inventory: includeInv.value,
    });
    if (!r?.success) { error.value = r?.error || '启动失败'; sorting.value = false; }
  } catch (e) { error.value = '启动失败'; sorting.value = false; }
}

async function cancelSort () {
  await invoke ('dnd:sort-cancel');
}

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
        } else if (m.type === 'character_updated') {
          const cid = m.character_id || '';
          activeCharacterId.value = cid;
          try {
            const d = await invoke ('dnd:characters');
            if (d?.characters) characters.value = d.characters;
          } catch (e) {}
          if (cid && !sorting.value && characters.value.some (c => c.id === cid)) {
            if (selected.value !== cid) selected.value = cid;
            if (charId.value !== cid) charId.value = cid;
            loadCharData (cid, true);
          }
        }
      } catch (e) {}
    };
    ws.onopen = () => {
      if (charId.value && !sorting.value) loadCharData (charId.value, true);
    };
    ws.onclose = () => {
      ws = null;
      if (!wsClosed) wsRetry = setTimeout (connectEvents, 3000);
    };
    ws.onerror = () => { try { ws.close (); } catch (e) {} };
  } catch (e) {}
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

let unsubs = [];
onMounted (async () => {
  await loadCharacters ();
  await restoreConfig ();
  checkUipi ();
  loadSortSpeed ();
  loadSortOrder ();
  try { servicePort.value = await invoke ('dnd:service-port'); } catch (e) {}
  try {
    const s = await invoke ('dnd:sort-status');
    if (s && s.running) sorting.value = true;
  } catch (e) {}
  unsubs = [
    window.electron.on ('dnd:sort-started', onSortStarted),
    window.electron.on ('dnd:sort-cancelled', onSortCancelled),
  ];
  window.addEventListener ('dnd:characters-refresh', onCharactersRefresh);
  poll = setInterval (pollStatus, 1000);
  connectEvents ();
});
onBeforeUnmount (() => {
  wsClosed = true;
  if (wsRetry) clearTimeout (wsRetry);
  if (ws) { try { ws.close (); } catch (e) {} ws = null; }
  if (poll) clearInterval (poll);
  window.removeEventListener ('dnd:characters-refresh', onCharactersRefresh);
  unsubs.forEach (u => u ());
  unsubs = [];
});
</script>

<template>
  <div>
    <div class="page-title">整理</div>
    <div class="page-sub"><b>请先在游戏中打开要整理的仓库界面</b>（能看到物品格子），再开始整理；整理期间保持游戏窗口在前台。</div>

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
                  :class="{ active: stashId === s.id }" @click="stashId = s.id"
                  :title="`${s.items.length} 件物品`">
            {{ s.label }}<span class="count">{{ s.items.length }}</span>
          </button>
        </div>

        <div class="stash-body card">
        <div class="stash-meta">
          <div class="stash-stat">
            <span class="stash-k">物品</span><span class="stash-v">{{ totalItems }}</span>
          </div>
          <div class="stash-stat">
            <span class="stash-k">规格</span>
            <span class="stash-v mono">{{ currentStash.width }}×{{ currentStash.height }}</span>
          </div>
          <div class="stash-stat grow">
            <span class="stash-k">占用</span>
            <span class="fill-track"><span class="fill-bar" :style="{ width: fillPct + '%' }"></span></span>
            <span class="stash-v">{{ fillPct }}%</span>
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
                 :style="itemStyle (it)"
                 :title="`${it.name} · ${it.rarity} · ${it.width}×${it.height}`">
              <img v-if="it.icon" class="item-icon" :src="iconUrl (it)" alt="" loading="lazy" />
              <!-- 仅显示图标，隐藏名字与数量
              <span class="cell-name">{{ it.name }}</span>
              <span v-if="it.quantity > 1" class="cell-qty">×{{ it.quantity }}</span>
              -->
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="loading" class="empty-hint"><div class="empty-t">加载中…</div></div>

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
            <label class="switch"><input type="checkbox" v-model="packMode"><span class="track"></span></label>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">堆叠模式</div>
            <div class="srow-d">先合并可堆叠物品再整理</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" v-model="stackMode"><span class="track"></span></label>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">包含背包物品</div>
            <div class="srow-d">把背包中的物品一并放入仓库</div>
          </div>
          <div class="srow-ctl">
            <label class="switch"><input type="checkbox" v-model="includeInv"><span class="track"></span></label>
          </div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">执行</div>
      <div v-if="uipiBlocked" class="uipi-warn">
        <b>鼠标模拟将被系统拦截</b>
        <span>检测到游戏以<b>管理员权限</b>运行，而 DarkTavern 不是。Windows 会拦截整理时的鼠标操作（游戏内光标不会移动）。请<b>以管理员身份运行 DarkTavern</b>（右键快捷方式 → 以管理员身份运行），或取消游戏快捷方式的"以管理员身份运行"后重试。</span>
      </div>
      <div class="card run-card">
        <div class="run-row">
          <div class="run-hints">
            <span class="hint"><span class="kbd">{{ SORT_HOTKEY }}</span> 开始整理</span>
            <span class="hint"><span class="kbd">{{ CANCEL_HOTKEY }}</span> 取消整理</span>
          </div>
          <button v-if="!sorting" class="btn primary lg" :disabled="!canStart" @click="startSort">开始整理</button>
          <button v-else class="btn danger lg" @click="cancelSort">取消整理</button>
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
  </div>
</template>

<style scoped>
.ctl-input { width: 130px; text-align: center; font-family: var(--mono); }

.run-card { padding: 16px 18px; }
.run-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.run-hints { display: flex; gap: 18px; }
.hint { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-3); }
.btn.lg { padding: 9px 24px; font-size: 14px; }
.btn:disabled { opacity: .45; cursor: default; transform: none; }

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
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
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
.side-tab .count { color: var(--text-3); font-size: 14px; font-variant-numeric: tabular-nums; }
.side-tab.active .count { color: rgba(255,255,255,0.85); }
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
.fill-track { flex: 1; max-width: 220px; height: 6px; border-radius: 4px; background: rgba(0,0,0,0.08); overflow: hidden; }
.fill-bar { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), #4aa8ff); transition: width .4s var(--ease); }

/* grid */
.grid-scroll { padding: 20px 18px 24px; overflow-x: auto; }
.stash-grid { position: relative; margin: 0 auto; }
.grid-bg { display: grid; gap: 2px; }
.bg-cell {
  background: var(--field-soft);
  border: 1px solid var(--line-soft);
  border-radius: 4px;
}
/* equipment page: fixed gear slots instead of a uniform grid */
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
  /* border: 1.5px solid var(--rc); */
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
.cell-item:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.2); z-index: 5; }
/*
.cell-name {
  position: relative; z-index: 1;
  font-size: 9.5px; font-weight: 650; line-height: 1.2; color: var(--rc);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
  text-shadow: 0 1px 2px rgba(0,0,0,0.85);
}
.cell-qty {
  position: absolute; top: 2px; right: 4px; z-index: 1;
  font-size: 9px; font-weight: 700; color: var(--rc);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0,0,0,0.85);
}
*/
</style>
