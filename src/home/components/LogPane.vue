<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const invoke = (channel, data) => window.electron.invoke (channel, data);

const entries = ref ([]);
const paused = ref (false);
const autoScroll = ref (true);
const expanded = ref (null);
const logList = ref (null);

const LEVELS = ['error', 'warn', 'info', 'debug'];
const levelOn = ref ({ error: true, warn: true, info: true, debug: true });

const LEVEL_CLS = {
  error: 'lg-error',
  warn: 'lg-warn',
  info: 'lg-info',
  debug: 'lg-debug',
};

let seq = 0;

function push (entry) {
  entries.value.push ({ ...entry, _id: ++seq });
  if (entries.value.length > 1000) entries.value.splice (0, entries.value.length - 1000);
  if (autoScroll.value) scrollBottom ();
}

function scrollBottom () {
  requestAnimationFrame (() => {
    if (logList.value) logList.value.scrollTop = logList.value.scrollHeight;
  });
}

function togglePause () {
  paused.value = !paused.value;
  if (!paused.value && autoScroll.value) scrollBottom ();
}

function clearLogs () {
  entries.value = [];
  expanded.value = null;
}

function copyEntry (e) {
  window.electron.clipboardWriteText (`[${e.ts}] [${e.level.toUpperCase ()}] [${e.module}] ${e.message}${Object.keys (e.meta || {}).length ? ' | ' + JSON.stringify (e.meta) : ''}`);
}

async function copyAll () {
  const text = entries.value.filter (f).map ((e) => `[${e.ts}] [${e.level.toUpperCase ()}] [${e.module}] ${e.message}${Object.keys (e.meta || {}).length ? ' | ' + JSON.stringify (e.meta) : ''}`).join ('\n');
  window.electron.clipboardWriteText (text);
}

function toggleExpand (id) {
  expanded.value = expanded.value === id ? null : id;
}

const modules = computed (() => {
  const s = new Set ();
  for (const e of entries.value) s.add (e.module || 'app');
  return [...s].sort ();
});

const moduleOn = ref ({});
function toggleModule (m) {
  // undefined=显示 → false=隐藏 → undefined=显示（首次点击立即生效）
  moduleOn.value[m] = moduleOn.value[m] === false ? undefined : false;
}

function allModulesOn () {
  return Object.values (moduleOn.value).every (v => v !== false);
}
function toggleAllModules () {
  const all = allModulesOn ();
  moduleOn.value = {};
  for (const m of modules.value) moduleOn.value[m] = !all;
}

function f (e) {
  if (!levelOn.value[e.level]) return false;
  const m = e.module || 'app';
  if (moduleOn.value[m] === false) return false;
  return true;
}

const filtered = computed (() => entries.value.filter (f));

const filteredCount = computed (() => filtered.value.length);

function fmtTs (ts) {
  return String (ts).replace ('T', ' ').replace ('Z', '').slice (0, 23);
}

let unsub = null;

onMounted (async () => {
  unsub = window.electron.on ('logs:append', (entry) => {
    if (!paused.value) push (entry);
  });
  try {
    const ring = await invoke ('logs:list');
    if (Array.isArray (ring)) {
      for (const e of ring) push (e);
    }
  } catch (e) {}
  scrollBottom ();
});

onBeforeUnmount (() => {
  if (unsub) unsub ();
});

function openFolder () {
  invoke ('logs:open-folder');
}
</script>

<template>
  <div class="log-pane">
    <div class="log-toolbar">
      <div class="log-filters">
        <label v-for="l in LEVELS" :key="l" class="lg-chk">
          <input type="checkbox" v-model="levelOn[l]"><span :class="['lg-dot', LEVEL_CLS[l]]"></span>{{ l }}
        </label>
        <span class="lg-sep"></span>
        <button class="lg-btn" @click="toggleAllModules">{{ allModulesOn () ? '全关模块' : '全开模块' }}</button>
      </div>
      <div class="log-actions">
        <button class="lg-btn" @click="togglePause">{{ paused ? '继续' : '暂停' }}</button>
        <button class="lg-btn" @click="clearLogs">清空</button>
        <button class="lg-btn" @click="copyAll">复制全部</button>
        <button class="lg-btn" @click="openFolder">日志文件夹</button>
      </div>
    </div>

    <div class="log-modules">
      <label v-for="m in modules" :key="m" class="lg-mod">
        <input type="checkbox" :checked="moduleOn[m] !== false" @change="toggleModule(m)"><span class="lg-mod-name">{{ m }}</span>
      </label>
      <span class="lg-count">共 {{ filteredCount }} 条 / {{ entries.length }} 条</span>
    </div>

    <div ref="logList" class="log-list">
      <div v-for="e in filtered" :key="e._id" class="lg-row" @click="toggleExpand(e._id)">
        <div class="lg-line">
          <span class="lg-ts">{{ fmtTs (e.ts) }}</span>
          <span :class="['lg-lv', LEVEL_CLS[e.level]]">{{ e.level.toUpperCase () }}</span>
          <span class="lg-mod">{{ e.module }}</span>
          <span class="lg-msg">{{ e.message }}</span>
        </div>
        <div v-if="expanded === e._id && Object.keys (e.meta || {}).length" class="lg-meta">
          <pre>{{ JSON.stringify (e.meta, null, 2) }}</pre>
        </div>
      </div>
      <div v-if="!filtered.length" class="lg-empty">无日志</div>
    </div>
  </div>
</template>

<style scoped>
.log-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.log-filters, .log-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lg-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.lg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.lg-error { background: #e5484d; color: #e5484d; }
.lg-warn  { background: #e5a93d; color: #e5a93d; }
.lg-info  { background: #5aa2e5; color: #5aa2e5; }
.lg-debug { background: #8a8f98; color: #8a8f98; }
.lg-sep { width: 1px; height: 14px; background: var(--line, #333); }
.lg-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--line, #444);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.lg-btn:hover { background: rgba(127,127,127,.15); }
.log-modules {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  font-size: 12px;
}
.lg-mod {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  user-select: none;
}
.lg-mod-name { font-family: ui-monospace, Consolas, monospace; }
.lg-count { margin-left: auto; opacity: .6; }
.log-list {
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid var(--line, #333);
  border-radius: 8px;
  padding: 6px 8px;
  font-family: ui-monospace, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.55;
  background: rgba(0,0,0,.25);
}
.lg-row { cursor: pointer; border-radius: 4px; }
.lg-row:hover { background: rgba(127,127,127,.12); }
.lg-line { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
.lg-ts { opacity: .55; flex-shrink: 0; }
.lg-lv { flex-shrink: 0; width: 46px; font-weight: 600; }
.lg-mod { opacity: .7; flex-shrink: 0; min-width: 64px; }
.lg-msg { overflow: hidden; text-overflow: ellipsis; }
.lg-meta {
  margin: 2px 0 6px 0;
  padding: 6px 8px;
  background: rgba(127,127,127,.12);
  border-radius: 6px;
}
.lg-meta pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
.lg-empty { text-align: center; opacity: .5; padding: 20px 0; }
</style>
