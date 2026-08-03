<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps ({
  bare: { type: Boolean, default: false },
});

const invoke = (ch, d) => window.electron.invoke (ch, d);

const packets = ref ([]);
const total = ref (0);
const page = ref (0);
const detail = ref (null);
const loading = ref (false);
const autoRefresh = ref (true);

const PAGE_SIZE = 50;
const pageCount = ref (0);

async function load () {
  loading.value = true;
  try {
    const d = await invoke ('dnd:packets', page.value, PAGE_SIZE);
    packets.value = d?.packets || [];
    total.value = d?.total || 0;
    pageCount.value = Math.max (1, Math.ceil (total.value / PAGE_SIZE));
  } catch (e) {}
  loading.value = false;
}

async function showDetail (id) {
  try { detail.value = await invoke ('dnd:packet-detail', id); } catch (e) {}
}

async function clear () {
  if (!confirm ('确定清空所有已捕获的数据包？')) return;
  await invoke ('dnd:packets-clear');
  packets.value = [];
  total.value = 0;
  detail.value = null;
  page.value = 0;
}

function prevPage () { if (page.value > 0) { page.value--; load (); } }
function nextPage () { if (page.value + 1 < pageCount.value) { page.value++; load (); } }

function fmtTime (ts) {
  if (!ts) return '—';
  return String (ts).slice (11, 19);
}

let timer = null;
onMounted (() => {
  load ();
  timer = setInterval (() => { if (autoRefresh.value && !detail.value) load (); }, 3000);
});
onBeforeUnmount (() => { if (timer) clearInterval (timer); });
</script>

<template>
  <div>
    <div v-if="!bare" class="page-title">数据包</div>
    <div v-if="!bare" class="page-sub">开发者工具：查看抓包捕获的原始游戏数据包与解码结果。</div>

    <div class="pkt-toolbar">
      <div class="pkt-count">共 <b>{{ total }}</b> 个包</div>
      <div class="pkt-actions">
        <label class="switch sm"><input type="checkbox" v-model="autoRefresh"><span class="track"></span></label>
        <span class="auto-label">自动刷新</span>
        <button class="btn subtle sm" @click="load">刷新</button>
        <button class="btn danger sm" @click="clear">清空</button>
      </div>
    </div>

    <div class="table-wrap" v-if="packets.length">
      <div class="table-scroll pkt-scroll">
        <table>
          <thead>
            <tr><th style="width:64px">ID</th><th style="width:90px">时间</th><th>类型</th><th style="width:80px">大小</th><th style="width:70px">已解析</th><th style="width:70px"></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in packets" :key="p.id">
              <td class="mono dim">{{ p.id }}</td>
              <td class="mono dim">{{ fmtTime (p.timestamp) }}</td>
              <td class="ptype">{{ p.type }}</td>
              <td class="mono">{{ p.raw_length }}</td>
              <td><span class="pdot" :class="{ ok: p.parsed }">{{ p.parsed ? '✓' : '—' }}</span></td>
              <td><button class="btn subtle sm" @click="showDetail (p.id)">详情</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else class="empty-hint"><div class="empty-t">暂无数据包</div><div class="empty-d">启动抓包并进入游戏后，捕获的数据包会显示在这里。</div></div>

    <div class="pager" v-if="total > PAGE_SIZE">
      <button class="btn subtle sm" :disabled="page === 0" @click="prevPage">上一页</button>
      <span class="page-ind">{{ page + 1 }} / {{ pageCount }}</span>
      <button class="btn subtle sm" :disabled="page + 1 >= pageCount" @click="nextPage">下一页</button>
    </div>

    <div v-if="detail" class="detail card">
      <div class="detail-head">
        <span class="detail-t">包 <span class="mono">#{{ detail.id }}</span> · {{ detail.type }}</span>
        <button class="btn subtle sm" @click="detail = null">关闭</button>
      </div>
      <pre class="detail-json">{{ JSON.stringify (detail.json, null, 2) }}</pre>
    </div>
  </div>
</template>

<style scoped>
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.dim { color: var(--text-3); font-size: 12px; }

.pkt-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin-bottom: 14px;
}
.pkt-count { font-size: 13px; color: var(--text-3); }
.pkt-count b { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }
.pkt-actions { display: flex; align-items: center; gap: 9px; }
.auto-label { font-size: 12.5px; color: var(--text-3); margin-right: 4px; }
.switch.sm { width: 38px; height: 22px; }
.switch.sm .track::before { width: 16px; height: 16px; }
.switch.sm input:checked + .track::before { left: 18px; }

.ptype { font-family: var(--mono); font-size: 12px; color: var(--accent); font-weight: 600; }
.pdot { color: var(--text-3); font-weight: 700; }
.pdot.ok { color: var(--green); }
.pkt-scroll { max-height: 380px; }

.empty-hint {
  padding: 44px 20px; text-align: center;
  background: var(--card); border: 1.5px dashed var(--line);
  border-radius: var(--r-card);
}
.empty-t { font-size: 15px; font-weight: 650; color: var(--text-2); }
.empty-d { margin-top: 7px; font-size: 13px; color: var(--text-3); }

.pager { display: flex; align-items: center; gap: 14px; margin-top: 13px; }
.page-ind { font-size: 12.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.btn:disabled { opacity: .45; cursor: default; transform: none; }

.detail { margin-top: 18px; }
.detail-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--line-soft);
  background: var(--card-2);
}
.detail-t { font-size: 13px; font-weight: 650; color: var(--text); }
.detail-t .mono { color: var(--accent); }
.detail-json {
  margin: 0; padding: 15px 16px;
  font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
  color: var(--text-2); max-height: 420px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
}
</style>
