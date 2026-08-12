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

// ── 上架自定义设置 ──

const sellSpeed = ref ('normal');
const sellPriceFactor = ref (1.0);
const sellMinPrice = ref (200);
const sellMinRarity = ref ('');

const RARITY_OPTS = [
  { key: '', label: '全部' },
  { key: 'Uncommon', label: '优秀+' },
  { key: 'Rare', label: '罕见+' },
  { key: 'Epic', label: '史诗+' },
  { key: 'Legendary', label: '传说+' },
];
const SPEED_OPTS = [
  { key: 'fast', label: '快' },
  { key: 'normal', label: '中' },
  { key: 'slow', label: '慢' },
];

async function loadSellSettings () {
  try {
    const d = await invoke ('settings:get');
    sellSpeed.value = d.sell_speed || 'normal';
    sellPriceFactor.value = parseFloat (d.sell_price_factor) || 1.0;
    const mp = parseInt (d.sell_min_price);
    sellMinPrice.value = isNaN (mp) ? 200 : mp;
    sellMinRarity.value = d.sell_min_rarity || '';
  } catch (e) {}
}

function saveSellSettings () {
  invoke ('settings:save', {
    sell_price_factor: sellPriceFactor.value,
    sell_min_price: sellMinPrice.value,
    sell_min_rarity: sellMinRarity.value,
  });
}

async function setSellSpeed (v) {
  sellSpeed.value = v;
  try {
    await invoke ('settings:save', { sell_speed: v });
    await invoke ('market:settings', { sell_speed: v });
  } catch (e) {}
}

onMounted (async () => {
  await loadCalibration ();
  await loadSellSettings ();
});
</script>

<template>
  <div>
    <div class="page-title">自动上架</div>
    <div class="page-sub">上架操作已并入「角色仓库」页（点击物品格子多选后查价上架）；此处配置坐标校准与上架规则。</div>

    <div class="sec">
      <div class="sec-label">上架坐标校准</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">校准说明</div>
            <div class="srow-d">点「记录」后，把鼠标移到游戏内对应按钮上<b>点击一次</b>即完成采集；全部按钮已内置默认坐标，仅在默认坐标不准时校准。</div>
          </div>
          <div class="srow-ctl">
            <button class="btn primary" :disabled="calSaving || pendingCount === 0" @click="saveCalibration">
              {{ calSaving ? '保存中…' : '保存校准' }}
            </button>
            <button class="btn subtle" @click="resetCalibration">清除校准</button>
            <span v-if="calNote" class="sel-note">{{ calNote }}</span>
          </div>
        </div>
        <div class="srow" v-for="a in anchors" :key="a.key">
          <div class="srow-info">
            <div class="srow-t">{{ a.label }}</div>
            <div class="srow-d">
              <template v-if="a.pending">待保存 ({{ a.pending.x }}, {{ a.pending.y }})</template>
              <template v-else-if="a.saved">已校准 ({{ a.saved.x }}, {{ a.saved.y }})</template>
              <template v-else-if="a.has_default">内置默认坐标</template>
              <template v-else>未校准</template>
            </div>
          </div>
          <div class="srow-ctl">
            <button class="btn sm" :disabled="armingKey !== ''" @click="recordAnchor(a.key)">
              {{ armingKey === a.key ? '等待点击…' : '记录' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-label">上架自定义设置</div>
      <div class="card">
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">上架速度</div>
            <div class="srow-d">页面渲染等待时长；快=省时，慢=更稳</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in SPEED_OPTS" :key="o.key" class="seg-opt" :class="{ on: sellSpeed === o.key }" @click="setSellSpeed(o.key)">
                <span class="seg-t">{{ o.label }}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">价格系数</div>
            <div class="srow-d">上架价 = 市场价 × 系数（0.1-3）；如 0.95 快速出手</div>
          </div>
          <div class="srow-ctl">
            <div class="days-ctl">
              <input type="text" inputmode="decimal" :value="sellPriceFactor" @change="e => { sellPriceFactor = parseFloat (e.target.value) || 1.0; saveSellSettings (); }">
            </div>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">最低价阈值</div>
            <div class="srow-d">市场价低于该值的物品不查价不上架；0 为不限制</div>
          </div>
          <div class="srow-ctl">
            <div class="days-ctl">
              <input type="text" inputmode="numeric" :value="sellMinPrice" @change="e => { sellMinPrice = parseInt (e.target.value) || 0; saveSellSettings (); }">
              <span class="range-val">金币</span>
            </div>
          </div>
        </div>
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">稀有度筛选</div>
            <div class="srow-d">只上架 ≥ 指定稀有度的物品</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in RARITY_OPTS" :key="o.key" class="seg-opt" :class="{ on: sellMinRarity === o.key }" @click="sellMinRarity = o.key; saveSellSettings ();">
                <span class="seg-t">{{ o.label }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>
