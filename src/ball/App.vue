<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import StatusPanel from './components/StatusPanel.vue';

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
});

const expanded = ref (false);

let dragActive = false;
let suppressClick = false;

const ring = computed (() => {
  if (!status.ocr) return 'bad';
  if (!status.game || !status.apiKey) return 'warn';
  return 'ok';
});

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

  window.electron.on ('ball:status', (d) => {
    const wasLocked = status.locked;
    Object.assign (status, d);
    if (d.locked && wasLocked === false && expanded.value) collapse ();
  });
  window.electron.on ('ball:blur', () => collapse ());
  window.addEventListener ('contextmenu', onContext);
});
</script>

<template>
  <div class="ball-root">
    <div class="ball-anchor">
      <div class="ring" :class="ring">
        <div class="ball" :class="{ locked: status.locked }" @mousedown="onBallMouseDown" @mouseup="onBallMouseUp" @click="onBallClick" @contextmenu="onContext">
          <svg class="icon" viewBox="0 0 576 512" fill="currentColor"><path d="M0 80l0 48c0 17.7 14.3 32 32 32l16 0 48 0 0-80c0-26.5-21.5-48-48-48S0 53.5 0 80zM112 32c10 13.4 16 30 16 48l0 304c0 35.3 28.7 64 64 64s64-28.7 64-64l0-5.3c0-32.4 26.3-58.7 58.7-58.7L480 320l0-192c0-53-43-96-96-96L112 32zM464 480c61.9 0 112-50.1 112-112c0-8.8-7.2-16-16-16l-245.3 0c-14.7 0-26.7 11.9-26.7 26.7l0 5.3c0 53-43 96-96 96l176 0 96 0z"/></svg>
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
