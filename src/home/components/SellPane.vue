<script setup>
import { onMounted, ref, computed } from 'vue';

const invoke = (channel, data) => window.electron.invoke (channel, data);

// ── 市场上架坐标校准 ──

// 锚点数据（默认/已校准/待保存）统一来自后端 /market/calibration，前端不维护第二份坐标
const anchors = ref ([]);
const calNote = ref ('');
const calSaving = ref (false);
const calMode = ref ('default');
const armingKey = ref ('');
const pendingCount = computed (() => anchors.value.filter (a => a.pending).length);

// 拉取锚点列表；后端服务未就绪（启动中）时自动轮询重试，就绪后自动填充显示
async function loadCalibration () {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await invoke ('market:calibration-status');
      if (Array.isArray (r?.anchors)) { anchors.value = r.anchors; return true; }
    } catch (e) {}
    await new Promise (res => setTimeout (res, 500));
  }
  return false;
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

// 切到手动校准立即重新拉取锚点列表（避免首次加载失败时列表为空、只有保存/清除）
function switchCalMode (m) {
  calMode.value = m;
  if (m === 'manual') loadCalibration ();
}

// ── 上架自定义设置 ──

const sellSpeed = ref ('fast');
const sellPriceFactor = ref (1.0);
const sellPriceBasis = ref ('smart');
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
const BASIS_OPTS = [
  { key: 'live', label: '现价' },
  { key: 'market', label: '均价' },
  { key: 'smart', label: '智能' },
];

async function loadSellSettings () {
  try {
    const d = await invoke ('settings:get');
    sellSpeed.value = d.sell_speed || 'fast';
    sellPriceFactor.value = parseFloat (d.sell_price_factor) || 1.0;
    sellPriceBasis.value = ['live', 'market', 'smart'].includes (d.sell_price_basis) ? d.sell_price_basis : 'smart';
    const mp = parseInt (d.sell_min_price);
    sellMinPrice.value = isNaN (mp) ? 200 : mp;
    sellMinRarity.value = d.sell_min_rarity || '';
  } catch (e) {}
}

function saveSellSettings () {
  invoke ('settings:save', {
    sell_price_factor: sellPriceFactor.value,
    sell_price_basis: sellPriceBasis.value,
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
  loadCalibration ();   // 刷新已校准/待保存状态（失败无碍，默认坐标已内置显示）
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
            <div class="srow-t">校准方式</div>
            <div class="srow-d">全部按钮已内置默认坐标（默认配置）；默认坐标不准时切到「手动校准」。</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button class="seg-opt" :class="{ on: calMode === 'default' }" @click="switchCalMode('default')"><span class="seg-t">默认配置</span></button>
              <button class="seg-opt" :class="{ on: calMode === 'manual' }" @click="switchCalMode('manual')"><span class="seg-t">手动校准</span></button>
            </div>
          </div>
        </div>
        <template v-if="calMode === 'manual'">
          <div class="cal-grid">
            <div class="cal-cell" v-for="a in anchors" :key="a.key">
              <div class="cal-name">{{ a.label }}</div>
              <div class="cal-state">
                <template v-if="a.pending">待保存 ({{ a.pending.x }}, {{ a.pending.y }})</template>
                <template v-else-if="a.saved">已校准 ({{ a.saved.x }}, {{ a.saved.y }})</template>
                <template v-else>默认 ({{ a.default?.x ?? '-' }}, {{ a.default?.y ?? '-' }})</template>
              </div>
              <button class="btn sm" :disabled="armingKey !== ''" @click="recordAnchor(a.key)">
                {{ armingKey === a.key ? '等待点击…' : '记录' }}
              </button>
            </div>
          </div>
          <div class="cal-actions">
            <button class="btn primary" :disabled="calSaving || pendingCount === 0" @click="saveCalibration">
              {{ calSaving ? '保存中…' : '保存校准' }}
            </button>
            <button class="btn subtle" @click="resetCalibration">清除校准</button>
            <span v-if="calNote" class="sel-note">{{ calNote }}</span>
          </div>
        </template>
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
            <div class="srow-t">价格基准</div>
            <div class="srow-d">上架价以哪个价为基础（再乘价格系数）；现价=最低挂单，均价=成交均价；智能=现价可信时用现价，被异常低价单拉低时自动改用均价</div>
          </div>
          <div class="srow-ctl">
            <div class="seg">
              <button v-for="o in BASIS_OPTS" :key="o.key" class="seg-opt" :class="{ on: sellPriceBasis === o.key }" @click="sellPriceBasis = o.key; saveSellSettings ();">
                <span class="seg-t">{{ o.label }}</span>
              </button>
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
        <div class="srow">
          <div class="srow-info">
            <div class="srow-t">价格系数</div>
            <div class="srow-d">上架价 = 基准价 × 系数（0.1-3）；如 0.95 快速出手</div>
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
      </div>
    </div>
  </div>
</template>

<style scoped>
.cal-toggle { cursor: pointer; user-select: none; }
.cal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px 14px;
  padding: 10px 18px 14px;
  background: var(--card-2);
  border-top: 1px solid var(--line-soft);
}
.cal-cell { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.cal-name { font-size: 12px; font-weight: 650; color: var(--text-2); }
.cal-state { font-size: 11px; color: var(--text-3); }
.cal-actions { display: flex; align-items: center; gap: 8px; padding: 8px 18px 12px; }
.cal-actions .sel-note { font-size: 12.5px; color: var(--green); }
</style>
