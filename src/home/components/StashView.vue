<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import StashPane from './StashPane.vue';

const props = defineProps ({
  charId: { type: String, default: '' },
  stashId: { type: String, default: '' },
});
const emit = defineEmits ([ 'update:charId', 'update:stashId', 'update:equipment', 'update:active' ]);

const invoke = (ch, d) => window.electron.invoke (ch, d);

// ── 仓库切换快捷键 ──
const stashNextKey = ref ('Ctrl+Tab');
const stashDefaultKey = ref ('Ctrl+E');
const listeningKey = ref (null);
const newKey = ref (null);

function keyLabel (target) {
  if (listeningKey.value === target) return '等待输入…（按 Esc 取消）';
  return '点击此处，然后按下新按键';
}

function startKeyListen (target) { listeningKey.value = target; newKey.value = null; }
function stopKeyListen () { listeningKey.value = null; }

function onKeyDown (e) {
  if (!listeningKey.value) return;
  e.preventDefault ();
  if (e.key === 'Escape') { listeningKey.value = null; newKey.value = null; return; }
  if (['F5', 'F6', 'F7', 'F8'].includes (e.key)) return;
  let key = '';
  if (e.ctrlKey) key += 'Ctrl+';
  if (e.altKey) key += 'Alt+';
  if (e.shiftKey) key += 'Shift+';
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return;
  const base = e.key.length === 1 ? e.key.toUpperCase () : e.key;
  key += base;
  if (['F1', 'F2', 'F3', 'F4', 'F9', 'F10', 'F11', 'F12', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes (base) || key.includes ('+')) {
    newKey.value = key;
    listeningKey.value = null;
  }
}

async function saveKey (field, target) {
  if (!newKey.value) return;
  const r = await invoke ('settings:save', { [field]: newKey.value });
  if (r?.success) {
    if (target === 'next') stashNextKey.value = newKey.value;
    else stashDefaultKey.value = newKey.value;
    newKey.value = null;
  }
}

async function loadKeys () {
  try {
    const d = await invoke ('settings:get');
    if (d?.stash_next_key) stashNextKey.value = d.stash_next_key;
    if (d?.stash_default_key) stashDefaultKey.value = d.stash_default_key;
  } catch (e) {}
}

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

function slotStyle (s) {
  return {
    left: s.x * (CELL + GAP) + 'px',
    top: s.y * (CELL + GAP) + 'px',
    width: s.w * CELL + (s.w - 1) * GAP + 'px',
    height: s.h * CELL + (s.h - 1) * GAP + 'px',
  };
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
  loadKeys ();
  document.addEventListener ('keydown', onKeyDown);
  window.addEventListener ('dnd:characters-refresh', onCharactersRefresh);
  connectEvents ();
  reportStashState ();
});

onBeforeUnmount (() => {
  wsClosed = true;
  if (wsRetry) clearTimeout (wsRetry);
  if (ws) { try { ws.close (); } catch (e) {} ws = null; }
  document.removeEventListener ('keydown', onKeyDown);
  window.removeEventListener ('dnd:characters-refresh', onCharactersRefresh);
});

watch (stashList, () => reportStashState ());
watch (() => props.stashId, () => reportStashState ());
</script>

<template>
  <div>
    <StashPane />

    <!-- 仓库切换快捷键 -->
    <div class="sec">
      <div class="sec-label">仓库切换快捷键</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">循环切换仓库</div>
            <div class="srow-d">在仓库列表中循环切换下一个仓库</div>
          </div>
          <div class="srow-ctl">
            <span class="kbd">{{ stashNextKey }}</span>
            <button class="keybind-btn" :class="{ listening: listeningKey === 'next' }" @click="startKeyListen('next')">{{ keyLabel('next') }}</button>
            <button class="btn primary" @click="saveKey('stash_next_key', 'next')">保存</button>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">切默认仓库</div>
            <div class="srow-d">切换到仓库列表第一个仓库</div>
          </div>
          <div class="srow-ctl">
            <span class="kbd">{{ stashDefaultKey }}</span>
            <button class="keybind-btn" :class="{ listening: listeningKey === 'default' }" @click="startKeyListen('default')">{{ keyLabel('default') }}</button>
            <button class="btn primary" @click="saveKey('stash_default_key', 'default')">保存</button>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">直达仓库页</div>
            <div class="srow-d">Alt+1–8 直达仓库列表第 1–8 个仓库（固定）</div>
          </div>
        </div>
      </div>
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
      <div class="empty-d">启动抓包后，在游戏中选择角色并打开仓库，数据会自动出现在这里。</div>
    </div>

    <!-- 仓库网格 -->
    <div v-if="charData && currentStash" class="sec">
      <div class="sec-label">{{ charData.nickname }} 的仓库</div>

      <div class="stash-layout">
        <div class="stash-side">
          <button v-for="s in stashList" :key="s.id" class="side-tab"
                  :class="{ active: props.stashId === s.id }" @click="emit('update:stashId', s.id)"
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
            </div>
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
.cell-item:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.2); z-index: 5; }

html[data-theme="dark"] .fill-track { background: rgba(255,255,255,0.10); }
html[data-theme="dark"] .bg-cell { background: rgba(255,255,255,0.03); }
</style>
