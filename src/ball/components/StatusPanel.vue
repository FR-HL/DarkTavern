<script setup>
import { computed } from 'vue';
import { cnClass } from '@/shared/lib/classes.js';

const props = defineProps ({
  status: { type: Object, required: true },
});
const emit = defineEmits ([ 'collapse', 'open-home', 'open-settings' ]);

const classIcons = import.meta.glob ('@assets/classes/*.avif', { eager: true, import: 'default' });
function classIcon (cls) {
  const f = (cls || '').toLowerCase ();
  const hit = Object.entries (classIcons).find (([k]) => k.endsWith (f + '.avif'));
  return hit ? hit[1] : null;
}

const liveClass = computed (() => {
  const s = props.status;
  if (!s.ocr) return 'bad';
  if (!s.game || !s.apiKey) return 'warn';
  return 'ok';
});

const coreRows = computed (() => [
  { k: 'OCR 引擎', state: props.status.ocr ? 'ok' : 'bad', v: props.status.ocr ? '已就绪' : '唤醒中…' },
  { k: '游戏窗口', state: props.status.game ? 'ok' : 'pending', v: props.status.game ? '已检测到' : '等待游戏…' },
  { k: '扫描热键', state: 'ok', v: props.status.scanKey || 'XButton1', mono: true },
  { k: 'DarkerDB API', state: props.status.apiKey ? 'ok' : 'pending', v: props.status.apiKey ? '已配置' : '未配置' },
]);

const char = computed (() => props.status.character || null);

const charRow = computed (() => {
  if (!char.value) {
    return { state: 'pending', v: '未捕获角色', icon: null };
  }
  const c = char.value;
  return {
    state: 'ok',
    v: `${c.nickname} · ${cnClass (c.cls)} Lv${c.level}`,
    icon: classIcon (c.cls),
  };
});

const stashRow = computed (() => {
  if (!char.value) return { state: 'pending', v: '—' };
  const c = char.value;
  return { state: 'ok', v: `${c.stashCount} 仓库 · ${c.totalItems} 物品 · ${relTime (c.updatedAt)}更新` };
});

const toolRows = computed (() => {
  const rows = [
    { k: '抓包', state: props.status.captureRunning ? 'ok' : 'pending', v: props.status.captureRunning ? '运行中' : '已停止' },
    { k: '仓库整理', state: props.status.sortingRunning ? 'ok' : 'pending', v: props.status.sortingRunning ? '进行中' : '空闲' },
  ];
  const finish = props.status.lastSortText;
  if (finish) rows[1] = { ...rows[1], v: finish, finish: true };
  return rows;
});

const scanRow = computed (() => {
  const s = props.status.lastScan || {};
  if (s.ok == null) return { state: 'pending', v: '—' };
  if (!s.ok) return { state: 'bad', v: s.message || '未找到' };
  const price = s.price ?? s.market;
  return { state: 'ok', v: `${s.name || '—'} · ${fmtG (price)}` };
});

function relTime (iso) {
  if (!iso) return '';
  const t = new Date (iso).getTime ();
  if (isNaN (t)) return '';
  const diff = Math.max (0, (Date.now () - t) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor (diff / 60) + ' 分钟前';
  return Math.floor (diff / 3600) + ' 小时前';
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

    <div class="stat-row" v-for="r in coreRows" :key="r.k">
      <span class="sdot" :class="r.state"></span>
      <span class="stat-k">{{ r.k }}</span>
      <span class="stat-v" :class="[r.state, { mono: r.mono }]">{{ r.v }}</span>
    </div>

    <div class="sec-divider">仓库工具</div>
    <div class="stat-row" v-for="r in toolRows" :key="r.k">
      <span class="sdot" :class="r.state"></span>
      <span class="stat-k">{{ r.k }}</span>
      <span class="stat-v" :class="r.state">{{ r.v }}</span>
    </div>
    <div class="stat-row">
      <span class="sdot" :class="charRow.state"></span>
      <span class="stat-k">当前角色</span>
      <span class="stat-v char-cell" :class="charRow.state">
        <img v-if="charRow.icon" class="char-icon" :src="charRow.icon" alt="" />
        <span class="char-name">{{ charRow.v }}</span>
      </span>
    </div>
    <div class="stat-row">
      <span class="sdot" :class="stashRow.state"></span>
      <span class="stat-k">仓库数据</span>
      <span class="stat-v" :class="stashRow.state">{{ stashRow.v }}</span>
    </div>

    <div class="sec-divider">动态</div>
    <div class="stat-row">
      <span class="sdot" :class="scanRow.state"></span>
      <span class="stat-k">最近查价</span>
      <span class="stat-v ellipsis" :class="scanRow.state">{{ scanRow.v }}</span>
    </div>

    <div class="panel-foot">
      <button class="btn primary foot" @click="emit('open-home')">打开主页</button>
      <button class="btn subtle foot" @click="emit('open-settings')">查价器设置</button>
    </div>
  </div>
</template>
