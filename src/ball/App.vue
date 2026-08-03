<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import StatusPanel from './components/StatusPanel.vue';
import { cnClass } from '@/shared/lib/classes.js';

const invoke = (channel, data) => window.electron.invoke (channel, data);

const status = reactive ({
  locked: true,
  ocr: false,
  game: false,
  scanKey: 'XButton1',
  apiKey: false,
  captureRunning: false,
  sortingRunning: false,
  scanning: false,
  version: '—',
  mappings: 0,
  sortJustFinished: false,
  sortOk: false,
  charJustUpdated: false,
  character: null,
  lastScan: { ok: null, name: '', price: null, market: null, message: '' },
});

const expanded = ref (false);
const transient = ref (null);

let dragActive = false;
let suppressClick = false;
let transientTimer = null;

const ring = computed (() => {
  if (!status.ocr) return 'bad';
  if (!status.game || !status.apiKey) return 'warn';
  return 'ok';
});

const center = computed (() => {
  if (status.scanning) return { t1: '扫描', t2: '', cls: 'busy' };
  const t = transient.value;
  if (t && t.until > Date.now ()) {
    if (t.kind === 'ok') return { t1: '✓', t2: t.sub, cls: 'ok' };
    if (t.kind === 'fail') return { t1: '✗', t2: t.sub, cls: 'bad' };
    if (t.kind === 'sortok') return { t1: '成', t2: '完成', cls: 'ok' };
    if (t.kind === 'sortfail') return { t1: '败', t2: '失败', cls: 'bad' };
    if (t.kind === 'char') return { t1: t.sub, t2: '已更新', cls: 'busy', small: true };
  }
  if (!status.ocr) return { t1: '故障', t2: '', cls: 'bad' };
  if (status.sortingRunning) return { t1: '整理', t2: '', cls: 'busy' };
  if (!status.game || !status.apiKey) return { t1: '待机', t2: '', cls: 'warn' };
  return { t1: '就绪', t2: '', cls: 'ok' };
});

function setTransient (kind, sub, dur) {
  clearTimeout (transientTimer);
  transient.value = { kind, sub, until: Date.now () + dur };
  transientTimer = setTimeout (() => { transient.value = null; }, dur + 50);
}

function fmtG (v) {
  if (v == null) return '暂无';
  const n = Number (v);
  if (n >= 10000) {
    const w = n / 10000;
    return (w >= 100 ? Math.round (w) : Math.round (w * 10) / 10) + 'w G';
  }
  return String (Math.round (n)) + ' G';
}

function onScanResult (d) {
  if (!d || d.ok == null) return;
  if (d.ok) {
    const price = d.price ?? d.market;
    setTransient ('ok', fmtG (price), 3000);
  } else {
    setTransient ('fail', '未找到', 3000);
  }
}

function onStatus (d) {
  const wasLocked = status.locked;
  Object.assign (status, d);
  if (d.locked && wasLocked === false && expanded.value) collapse ();

  if (d.charJustUpdated && d.character) {
    const cls = cnClass (d.character.cls) || '角色';
    setTransient ('char', cls, 3000);
  }
  if (d.sortJustFinished) {
    setTransient (d.sortOk ? 'sortok' : 'sortfail', '', 5000);
  }
}

function toggle () {
  expanded.value = !expanded.value;
  invoke ('ball:resize', { expanded: expanded.value });
}
function collapse () {
  if (!expanded.value) return;
  expanded.value = false;
  invoke ('ball:resize', { expanded: false });
}
function onMenu () { invoke ('ball:menu'); }
function openHome () { invoke ('ball:open-home'); }
function openSettings () { invoke ('ball:open-settings'); }
function onBallMouseDown (e) {
  if (e.button !== 0 || status.locked) return;
  dragActive = true;
  suppressClick = false;
  invoke ('ball:drag-start');
}
async function onBallMouseUp (e) {
  if (e.button !== 0 || !dragActive) return;
  dragActive = false;
  const r = await invoke ('ball:drag-end').catch (() => ({ moved: false }));
  if (r && r.moved) { suppressClick = true; return; }
  if (status.locked) return;
  toggle ();
}
function onBallClick () {
  if (suppressClick) suppressClick = false;
}
function onContext (e) {
  e.preventDefault ();
  onMenu ();
}

onMounted (async () => {
  const s = await invoke ('ball:get-status').catch (() => null);
  if (s) Object.assign (status, s);

  window.electron.on ('ball:status', onStatus);
  window.electron.on ('ball:scan-result', onScanResult);
  window.electron.on ('ball:blur', () => collapse ());
  window.addEventListener ('contextmenu', onContext);
});

onBeforeUnmount (() => {
  clearTimeout (transientTimer);
});
</script>

<template>
  <div class="ball-root">
    <div class="ball-anchor">
      <div class="ring" :class="ring">
        <div class="ball" :class="{ locked: status.locked }" @mousedown="onBallMouseDown" @mouseup="onBallMouseUp" @click="onBallClick" @contextmenu="onContext">
          <div class="ball-text" :class="[center.cls, { small: center.small }]">
            <span class="bt-1">{{ center.t1 }}</span>
            <span v-if="center.t2" class="bt-2">{{ center.t2 }}</span>
          </div>
          <span v-if="status.scanning" class="pulse"></span>
        </div>
      </div>

      <Transition name="panel">
        <StatusPanel
          v-if="expanded"
          :status="status"
          @collapse="collapse"
          @open-home="openHome"
          @open-settings="openSettings"
        />
      </Transition>
    </div>
  </div>
</template>
