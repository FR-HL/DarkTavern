<script setup>
import { computed } from 'vue';

const props = defineProps ({
  status: { type: Object, required: true },
});
const emit = defineEmits ([ 'collapse', 'open-home', 'open-settings' ]);

const liveClass = computed (() => {
  const s = props.status;
  if (!s.ocr) return 'bad';
  if (!s.game || !s.apiKey) return 'warn';
  return 'ok';
});

const rows = computed (() => [
  { k: 'OCR 引擎', state: props.status.ocr ? 'ok' : 'bad', v: props.status.ocr ? '已就绪' : '唤醒中…' },
  { k: '游戏窗口', state: props.status.game ? 'ok' : 'pending', v: props.status.game ? '已检测到' : '等待游戏…' },
  { k: '扫描热键', state: 'ok', v: props.status.scanKey || 'XButton1', mono: true },
  { k: 'DarkerDB API', state: props.status.apiKey ? 'ok' : 'pending', v: props.status.apiKey ? '已配置' : '未配置' },
]);

const dndRows = computed (() => [
  { k: '抓包', state: props.status.captureRunning ? 'ok' : 'pending', v: props.status.captureRunning ? '运行中' : '已停止' },
  { k: '仓库整理', state: props.status.sortingRunning ? 'ok' : 'pending', v: props.status.sortingRunning ? '进行中' : '空闲' },
]);
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">DarkTavern</span>
      <span class="panel-live" :class="liveClass"></span>
      <span class="panel-sub">{{ status.version }} · {{ status.mappings.toLocaleString() }} 词条</span>
      <button class="panel-close" title="收起" @click="emit('collapse')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
      </button>
    </div>

    <div v-if="status.scanning" class="scanning-bar"><span class="scanning-dot"></span>正在查价…</div>

    <div class="stat-row" v-for="r in rows" :key="r.k">
      <span class="sdot" :class="r.state"></span>
      <span class="stat-k">{{ r.k }}</span>
      <span class="stat-v" :class="[r.state, { mono: r.mono }]">{{ r.v }}</span>
    </div>

    <div class="sec-divider">仓库工具</div>
    <div class="stat-row" v-for="r in dndRows" :key="r.k">
      <span class="sdot" :class="r.state"></span>
      <span class="stat-k">{{ r.k }}</span>
      <span class="stat-v" :class="r.state">{{ r.v }}</span>
    </div>

    <div class="panel-foot">
      <button class="btn primary foot" @click="emit('open-home')">打开主页</button>
      <button class="btn subtle foot" @click="emit('open-settings')">查价器设置</button>
    </div>
  </div>
</template>
