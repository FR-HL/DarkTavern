<script setup>
import { onMounted, ref, computed } from 'vue';

const invoke = (channel, data) => window.electron.invoke (channel, data);

// ── 市场上架坐标校准 ──

const anchors = ref ([]);
const calNote = ref ('');
const calSaving = ref (false);
const armingKey = ref ('');
const pendingCount = computed (() => anchors.value.filter (a => a.pending).length);

async function loadCalibration () {
  try {
    const r = await invoke ('market:calibration-status');
    anchors.value = r?.anchors || [];
  } catch (e) {}
}

async function recordAnchor (key) {
  armingKey.value = key;
  calNote.value = '请把鼠标移到游戏内目标位置，点击一下即记录…';
  try {
    const r = await invoke ('market:calibration-arm', key);
    if (r?.success) {
      calNote.value = `已记录 ${r.key} 位于 (${r.x}, ${r.y})，移向下一个目标`;
    } else if (r?.error === 'timeout') {
      calNote.value = '超时未检测到游戏内点击，请重试';
    } else {
      calNote.value = '记录失败：' + (r?.error || '未知错误');
    }
  } catch (e) {
    calNote.value = '记录失败，请重试';
  }
  armingKey.value = '';
  await loadCalibration ();
}

async function saveCalibration () {
  calSaving.value = true;
  const r = await invoke ('market:calibration-save');
  calSaving.value = false;
  calNote.value = r?.success ? '校准已保存' : '保存失败：请先记录至少一个位置';
  if (r?.success) await loadCalibration ();
}

async function resetCalibration () {
  const r = await invoke ('market:calibration-reset');
  calNote.value = r?.success ? '校准已清除' : '清除失败';
  if (r?.success) await loadCalibration ();
}

onMounted (async () => {
  await loadCalibration ();
});
</script>

<template>
  <div>
    <div class="page-title">自动上架</div>
    <div class="page-sub">上架操作已并入「角色仓库」页（点击物品格子多选后查价上架）；此处仅保留坐标校准。</div>

    <!-- 坐标校准 -->
    <div class="card" style="padding: 16px 18px;">
      <div class="card-head" style="margin-bottom: 10px;">
        <span class="card-title">上架坐标校准</span>
      </div>
      <div class="sel-d" style="margin-bottom: 12px;">
        点「记录」后，把鼠标移到游戏内对应按钮上<b>点击一次</b>即完成采集；全部按钮已内置默认坐标，仅在默认坐标不准时校准。
      </div>
      <div class="sel-anchors">
        <div class="sel-a" v-for="a in anchors" :key="a.key">
          <div class="sel-a-info">
            <div class="sel-a-t">{{ a.label }}</div>
            <div class="sel-a-d">
              <template v-if="a.pending">待保存 ({{ a.pending.x }}, {{ a.pending.y }})</template>
              <template v-else-if="a.saved">已校准 ({{ a.saved.x }}, {{ a.saved.y }})</template>
              <template v-else-if="a.has_default">内置默认坐标</template>
              <template v-else>未校准</template>
            </div>
          </div>
          <button class="btn sm" :disabled="armingKey !== ''" @click="recordAnchor(a.key)">
            {{ armingKey === a.key ? '等待点击…' : '记录' }}
          </button>
        </div>
      </div>
      <div class="sel-row" style="margin-top: 12px;">
        <button class="btn primary" :disabled="calSaving || pendingCount === 0" @click="saveCalibration">
          {{ calSaving ? '保存中…' : '保存校准' }}
        </button>
        <button class="btn subtle" @click="resetCalibration">清除校准</button>
        <span v-if="calNote" class="sel-note">{{ calNote }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sel-d { font-size: 12.5px; color: var(--text-3); line-height: 1.6; }
.sel-d b { color: var(--red); font-weight: 650; }
.sel-anchors { display: flex; flex-wrap: wrap; gap: 8px; }
.sel-a {
  display: flex; align-items: center; gap: 10px;
  background: var(--card-2); border: 1px solid var(--line-soft); border-radius: 8px;
  padding: 8px 10px; min-width: 220px;
}
.sel-a-info { flex: 1; min-width: 0; }
.sel-a-t { font-size: 13px; font-weight: 600; color: var(--text); }
.sel-a-d { margin-top: 2px; font-size: 11.5px; color: var(--text-3); }
.sel-row { display: flex; align-items: center; gap: 10px; }
.sel-note { font-size: 12.5px; color: var(--green); margin-left: 4px; }
.sel-note.warn { color: var(--red); }
</style>
