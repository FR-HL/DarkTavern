<script setup>
import { onMounted, ref, computed, watch } from 'vue';
import { RARITY_CN, rarityColor } from '@/shared/lib/rarity.js';
import { useSell } from '../composables/sell.js';

const invoke = (channel, data) => window.electron.invoke (channel, data);

const props = defineProps ({
  charId: { type: String, default: '' },
});

const { pricing, selling, status, note, fetchPrices, startSell, stopSell } = useSell ();

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

// ── 角色 / 物品 ──

const charName = ref ('');
const sellItems = ref ([]);

const allChecked = computed ({
  get () {
    const list = sellItems.value.filter (i => i.checked !== false);
    return list.length > 0 && list.every (i => i.checked);
  },
  set (v) {
    sellItems.value.forEach (i => { i.checked = v; });
  },
});

const checkedCount = computed (() => sellItems.value.filter (i => i.checked).length);
const pricedCount = computed (() => sellItems.value.filter (i => i.checked && i.price != null).length);

async function loadItems () {
  if (!props.charId) {
    sellItems.value = [];
    note.value = '请先在「角色仓库」页选择角色';
    return;
  }
  try {
    const d = await invoke ('dnd:character', props.charId);
    charName.value = d?.nickname || '';
    const stashes = d?.stashes || {};
    const list = [];
    for (const [sid, s] of Object.entries (stashes)) {
      if (parseInt (sid) < 4) continue;
      for (const it of (s.items || [])) {
        list.push ({
          uid: `${sid}:${it.x}:${it.y}`,
          stash_id: sid,
          stash_label: s.label,
          name: it.name,
          item_id: it.item_id,
          rarity: it.rarity || 'Common',
          quantity: it.quantity,
          x: it.x,
          y: it.y,
          w: it.width || 1,
          h: it.height || 1,
          sp: it.sp || [],
          price: null,
          checked: true,
        });
      }
    }
    list.sort ((a, b) => parseInt (a.stash_id) - parseInt (b.stash_id) || a.y - b.y || a.x - b.x);
    sellItems.value = list;
    note.value = list.length ? `已加载 ${list.length} 件可上架物品` : '该角色暂无仓库物品';
  } catch (e) {
    note.value = '加载角色仓库失败';
  }
}

async function doFetchPrices () {
  const targets = sellItems.value.filter (i => i.checked);
  if (!targets.length) return;
  await fetchPrices (targets);
}

async function doStartSell () {
  const targets = sellItems.value.filter (i => i.checked && i.price != null);
  if (!targets.length) {
    note.value = '请先查价，且至少一件物品有市场价';
    return;
  }
  await startSell (targets.map (i => ({
    stash_id: i.stash_id,
    x: i.x,
    y: i.y,
    w: i.w,
    h: i.h,
    price: i.price,
  })));
}

function rarityCn (r) { return RARITY_CN[r] || r; }
function rarityColorCss (r) { return rarityColor (r); }

onMounted (async () => {
  await loadCalibration ();
  if (props.charId) await loadItems ();
  else note.value = '请先在「角色仓库」页选择角色';
});
</script>

<template>
  <div>
    <div class="page-title">自动上架</div>
    <div class="page-sub">将仓库物品按 DarkerDB 市场现价自动上架到游戏市场（我的列表）。</div>

    <!-- 坐标校准 -->
    <div class="card" style="padding: 16px 18px; margin-bottom: 18px;">
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

    <!-- 上架 -->
    <div class="card" style="padding: 16px 18px;">
      <div class="card-head" style="margin-bottom: 12px;">
        <span class="card-title">上架操作</span>
      </div>

      <div class="srow" style="padding: 8px 0;">
        <div class="srow-info">
          <div class="srow-t">当前角色</div>
          <div class="srow-d">与「角色仓库」页同步；在角色仓库页切换角色后自动刷新</div>
        </div>
        <div class="srow-ctl">
          <span class="sel-char">{{ props.charId ? (charName || props.charId) : '未选择' }}</span>
          <button class="btn sm" :disabled="!props.charId" @click="loadItems">刷新物品</button>
        </div>
      </div>

      <div class="sel-items-head">
        <label class="sel-check">
          <input type="checkbox" v-model="allChecked" />
          <span>全选（{{ checkedCount }} 件）</span>
        </label>
        <button class="btn sm" :disabled="pricing || checkedCount === 0" @click="doFetchPrices">
          {{ pricing ? '查价中…' : '查询市场价' }}
        </button>
      </div>

      <div class="sel-table">
        <div class="sel-tr sel-th">
          <span class="sel-tc sel-c1"></span>
          <span class="sel-tc sel-c2">物品</span>
          <span class="sel-tc sel-c3">仓库</span>
          <span class="sel-tc sel-c4">数量</span>
          <span class="sel-tc sel-c5">市场价</span>
        </div>
        <div class="sel-tr" v-for="it in sellItems" :key="it.uid">
          <span class="sel-tc sel-c1">
            <input type="checkbox" v-model="it.checked" />
          </span>
          <span class="sel-tc sel-c2">
            <span class="sel-r" :style="{ color: rarityColorCss(it.rarity) }">{{ rarityCn(it.rarity) }}</span>
            {{ it.name }}
          </span>
          <span class="sel-tc sel-c3">{{ it.stash_label }}</span>
          <span class="sel-tc sel-c4">{{ it.quantity }}</span>
          <span class="sel-tc sel-c5">
            <template v-if="it.price != null">{{ it.price }} <span class="sel-g">金币</span></template>
            <template v-else-if="it.checked">—</template>
            <template v-else>跳过</template>
          </span>
        </div>
        <div v-if="!sellItems.length" class="sel-empty">{{ props.charId ? '暂无物品，请确认抓包数据已加载' : '请先在「角色仓库」页选择角色' }}</div>
      </div>

      <div class="sel-row" style="margin-top: 14px;">
        <button
          class="btn primary"
          :disabled="selling || pricedCount === 0"
          @click="doStartSell"
        >
          {{ selling ? `上架中 ${status?.current || 0}/${status?.total || 0}` : `开始上架（${pricedCount} 件）` }}
        </button>
        <button class="btn danger" v-if="selling" @click="stopSell">停止</button>
        <span v-if="note" class="sel-note" :class="{ warn: note.indexOf ('失败') >= 0 }">{{ note }}</span>
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
.sel { background: var(--card-2); border: 1px solid var(--line-soft); border-radius: 7px; color: var(--text); padding: 6px 10px; font-size: 13px; }
.sel-char { font-size: 13.5px; font-weight: 600; color: var(--text); }
.sel-items-head { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 10px; }
.sel-check { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.sel-table { border: 1px solid var(--line-soft); border-radius: 9px; overflow: hidden; max-height: 320px; overflow-y: auto; }
.sel-tr { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12.5px; color: var(--text-2); border-top: 1px solid var(--line-soft); }
.sel-tr:first-child { border-top: none; }
.sel-th { background: var(--card-2); font-weight: 650; color: var(--text-3); position: sticky; top: 0; }
.sel-tc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sel-c1 { width: 34px; flex: none; }
.sel-c2 { flex: 1; min-width: 0; }
.sel-c3 { width: 110px; flex: none; color: var(--text-3); }
.sel-c4 { width: 46px; flex: none; }
.sel-c5 { width: 110px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
.sel-r { font-size: 11.5px; margin-right: 5px; font-weight: 600; }
.sel-g { color: var(--gold, #d9a62e); font-size: 11.5px; }
.sel-empty { padding: 22px; text-align: center; color: var(--text-3); font-size: 12.5px; }
</style>
