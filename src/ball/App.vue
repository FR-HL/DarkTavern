<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { cnClass } from '@/shared/lib/classes.js';
import { rarityColor } from '@/shared/lib/rarity.js';

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
  frontStash: null,
  stashJustChanged: false,
  lastScan: { ok: null, name: '', price: null, market: null, message: '' },
});

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
  if (status.scanning) return { t1: '扫描', cls: 'busy' };
  const t = transient.value;
  if (t && t.until > Date.now ()) {
    if (t.kind === 'ok') return { t1: fmtPrice (t.price).n, cls: 'gold' };
    if (t.kind === 'fail') return { t1: '未找到', cls: 'bad' };
    if (t.kind === 'sortok') return { t1: '完成', cls: 'ok' };
    if (t.kind === 'sortfail') return { t1: '失败', cls: 'bad' };
    if (t.kind === 'char') return { t1: t.sub, cls: 'busy' };
    if (t.kind === 'stash') return { t1: t.sub, cls: 'busy', small: true };
  }
  if (!status.ocr) return { t1: '故障', cls: 'bad' };
  if (status.sortingRunning) return { t1: '整理', cls: 'busy' };
  if (!status.game || !status.apiKey) return { t1: '待机', cls: 'warn' };
  return { t1: '就绪', cls: 'ok' };
});

function fmtPrice (v) {
  if (v == null) return { n: '暂无' };
  const n = Number (v);
  if (n >= 10000) {
    const w = n / 10000;
    return { n: (w >= 100 ? Math.round (w) : Math.round (w * 10) / 10) + 'w' };
  }
  return { n: String (Math.round (n)) };
}

function setTransient (kind, sub, dur, extra) {
  clearTimeout (transientTimer);
  transient.value = { kind, sub, until: Date.now () + dur, ...extra };
  transientTimer = setTimeout (() => { transient.value = null; }, dur + 50);
}

function onScanResult (d) {
  if (!d || d.ok == null) return;
  const t = transient.value;
  const isLiveUpdate = !d.name && !d.zhName && d.price !== undefined && t && t.kind === 'ok' && t.until > Date.now ();
  if (isLiveUpdate) {
    transient.value = { ...t, price: d.price ?? t.price };
    return;
  }
  if (d.ok) {
    const price = d.price ?? null;
    setTransient ('ok', '', 3000, {
      name: d.zhName || d.name || '',
      price,
      color: rarityColor (d.rarity),
    });
  } else {
    setTransient ('fail', '未找到', 3000);
  }
}

function onStatus (d) {
  Object.assign (status, d);
  if (d.charJustUpdated && d.character) {
    const cls = cnClass (d.character.cls) || '角色';
    setTransient ('char', cls, 3000);
  }
  if (d.stashJustChanged && d.frontStash) {
    setTransient ('stash', d.frontStash.label || '仓库', 3000);
  }
  if (d.sortJustFinished) {
    setTransient (d.sortOk ? 'sortok' : 'sortfail', '', 3000);
  }
}

function onMenu () { invoke ('ball:menu'); }
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
  if (r && r.moved) suppressClick = true;
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
  window.electron.on ('ball:drag-ended', (d) => {
    dragActive = false;
    if (d && d.moved) suppressClick = true;
  });
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
          </div>
          <span v-if="status.scanning" class="pulse"></span>
        </div>
      </div>
    </div>
  </div>
</template>
