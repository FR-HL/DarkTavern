<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';

const invoke = (ch, d) => window.electron.invoke (ch, d);

const characters = ref ([]);
const charId = ref ('');
const stashes = ref ([]);
const stashId = ref ('');
const packMode = ref (false);
const stackMode = ref (false);
const includeInv = ref (false);
const sorting = ref (false);
const result = ref (null);
const error = ref ('');

const SORT_HOTKEY = 'Ctrl+F11';
const CANCEL_HOTKEY = 'Ctrl+F12';

const canStart = computed (() => !!charId.value && stashId.value !== '' && !sorting.value);

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
}

async function startSort () {
  if (!canStart.value) { error.value = '请选择角色和仓库'; return; }
  error.value = '';
  result.value = null;
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
  try {
    const s = await invoke ('dnd:sort-status');
    if (s && s.running) sorting.value = true;
  } catch (e) {}
  unsubs = [
    window.electron.on ('dnd:sort-started', onSortStarted),
    window.electron.on ('dnd:sort-cancelled', onSortCancelled),
  ];
  poll = setInterval (pollStatus, 800);
});
onBeforeUnmount (() => {
  if (poll) clearInterval (poll);
  unsubs.forEach (u => u ());
  unsubs = [];
});
</script>

<template>
  <div>
    <div class="page-title">整理</div>
    <div class="page-sub">规划最优布局并模拟鼠标拖拽，自动整理仓库。整理期间请保持游戏窗口在前台。</div>

    <div class="sec">
      <div class="sec-label">整理目标</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">角色</div>
            <div class="srow-d">选择要整理仓库的角色</div>
          </div>
          <div class="srow-ctl">
            <select v-model="charId" class="ctl-select">
              <option v-if="!characters.length" value="" disabled>暂无角色数据</option>
              <option v-for="c in characters" :key="c.id" :value="c.id">{{ c.class }} · {{ c.nickname }}</option>
            </select>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">仓库</div>
            <div class="srow-d">选择要整理的仓库（自动列出该角色的所有仓库）</div>
          </div>
          <div class="srow-ctl">
            <select v-model="stashId" class="ctl-select">
              <option v-if="!stashes.length" value="" disabled>{{ charId ? '该角色暂无仓库数据' : '请先选择角色' }}</option>
              <option v-for="s in stashes" :key="s.id" :value="s.id">{{ s.label }}（{{ s.count }} 件）</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">整理选项</div>
      <div class="card">
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
.ctl-select { width: 240px; }
.ctl-input { width: 130px; text-align: center; font-family: var(--mono); }

.run-card { padding: 16px 18px; }
.run-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.run-hints { display: flex; gap: 18px; }
.hint { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-3); }
.btn.lg { padding: 9px 24px; font-size: 14px; }
.btn:disabled { opacity: .45; cursor: default; transform: none; }

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
</style>
