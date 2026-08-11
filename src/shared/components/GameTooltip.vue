<script setup>
import { computed } from 'vue';

// 通用游戏样式提示框：复刻查价悬浮窗（哥特边框/纹理/分隔线/金币图标）。
// 可用作仓库悬停提示、物品详情展示等；位置由外部通过 style（fixed left/top）控制。

const props = defineProps ({
  title: { type: String, default: '' },
  titleColor: { type: String, default: '' },
  primary: { type: Array, default: () => [] },      // [{ name, value }] 固定属性
  secondary: { type: Array, default: () => [] },    // [{ name, value, selected, range, grade }] 随机属性
  prices: { type: Object, default: () => ({}) },    // { live, market, vendor, density } null=暂无
  stats: { type: Object, default: () => ({}) },     // { demand, demandColor, adventure }
  footer: { type: String, default: '作者: 方源Official | 官网: dnd.wiki' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
});

const emit = defineEmits ([ 'toggle-secondary' ]);

const PRICE_LABELS = [
  ['live', '市场现价'],
  ['market', '市场均价'],
  ['vendor', '商人回收'],
  ['density', '每格价值'],
];

const visiblePrices = computed (() =>
  PRICE_LABELS.filter (([k]) => props.prices[k] !== undefined)
);

function fmt (v) {
  if (v == null) return null;
  return Number (v).toLocaleString ();
}

function signed (v) {
  return v > 0 ? '+' + v : String (v);
}

// 词条等级颜色（与查价器悬浮窗一致：S 金/A 橙/B 紫/C 蓝/D 绿/F 白）
function gradeColor (grade) {
  const colors = {
    S: '#ecd99a',
    A: '#ff9a00',
    B: '#d067ff',
    C: '#00aaee',
    D: '#80d600',
    F: '#eeeeee',
  };
  return colors[grade] || 'inherit';
}
</script>

<template>
  <div class="gt-root">
    <div class="tooltip-overlay"></div>
    <div class="tooltip-content">
      <!-- 加载态 -->
      <div v-if="loading" class="spinner-wrapper">
        <img src="@assets/images/Loading_Img.png" alt="" class="spinner-image" />
        <div class="spinner-text">搜索中...</div>
      </div>

      <!-- 错误态 -->
      <div v-else-if="error" class="error-wrap">
        <div class="error-title"><span>⚠</span><span>错误</span></div>
        <div class="error-message">{{ error }}</div>
      </div>

      <!-- 正常 -->
      <template v-else>
        <div v-if="title" class="tooltip-title" :style="titleColor ? { color: titleColor } : {}">{{ title }}</div>
        <div class="tooltip-body" :class="{ 'no-title': !title }">
          <section v-if="primary.length">
            <div v-for="(p, i) in primary" :key="'p' + i" class="tooltip-primary"><b>{{ p.name }}</b><span>{{ p.value }}</span></div>
            <div class="tooltip-separator"></div>
          </section>

          <section v-if="secondary.length">
            <div v-for="(s, i) in secondary" :key="'s' + i">
              <div class="affix-line1">
                <span class="tooltip-attribute"><span><b>{{ signed (s.value) }}</b>&nbsp;{{ s.name }}</span></span>
                <span class="affix-check" :class="{ on: s.selected }" @click="emit('toggle-secondary', i)"></span>
              </div>
              <div v-if="s.range || s.grade" class="attr-sub">
                <span v-if="s.range">({{ s.range }})</span>
                <span v-if="s.grade" :style="{ color: gradeColor (s.grade) }"> ({{ s.grade }})</span>
              </div>
            </div>
            <div class="tooltip-separator"></div>
          </section>

          <section v-if="stats.demand != null || stats.adventure != null">
            <div class="tooltip-stats">
              <div v-if="stats.demand != null" class="tooltip-stat">
                <span>需求评分:</span>
                <span :style="stats.demandColor ? { color: stats.demandColor } : {}">{{ stats.demand }} / 10</span>
              </div>
              <div v-if="stats.adventure != null" class="tooltip-stat">
                <span>冒险点数:</span><span>{{ stats.adventure }}</span>
              </div>
            </div>
            <div class="tooltip-separator"></div>
          </section>

          <div v-if="visiblePrices.length" class="tooltip-prices">
            <div v-for="([k, label]) in visiblePrices" :key="k" class="price-row">
              <span>{{ label }}:</span>
              <span class="ml" :class="prices[k] !== null ? 'gold' : 'price-empty'">
                {{ prices[k] !== null ? fmt (prices[k]) : '暂无' }}
              </span>
            </div>
            <div class="tooltip-separator"></div>
          </div>

          <div class="tooltip-footer">{{ footer }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
@font-face {
  font-family: 'SaintKDG_Light';
  src: url('@assets/fonts/SaintKDG_Light.ttf') format('truetype');
}

.gt-root {
  --dnd-gold:       #ffd400;
  --dnd-light-gray: #989898;
  --dnd-dust:       #626262;
  --dnd-blue:       #00aaee;
  --dnd-oak:        #b18063;
  --dnd-green:      #80d600;
  --dnd-orange:     #ff9a00;
  --dnd-white:      #eeeeee;

  display: inline-block;
  position: relative;
  text-align: center;
  min-width: 250px;
  font-family: 'SaintKDG_Light', sans-serif;
  font-size: 14px;

  background-image: url('@assets/images/Background_TooltipTexture.png');
  background-size: 100% 100%;
  background-repeat: no-repeat;
  background-position: center;
  background-color: #14121a;

  border-image-slice: 21 21 21 21;
  border-image-width: 20px 20px 20px 20px;
  border-image-outset: 0;
  border-image-repeat: stretch;
  border-image-source: url('@assets/images/Background_TooltipBorder.png');

  box-shadow: 0 0 4px 2px rgba(0, 0, 0, 0.85);
}

.tooltip-overlay {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background-color: rgba(217, 210, 219, 0.025);
  pointer-events: none;
}

.tooltip-content { position: relative; padding: 2px; text-align: center; }

.tooltip-title { padding: 8px 0; font-size: 19px; }
.tooltip-title:after {
  content: '';
  display: block;
  width: 100%;
  height: 3px;
  margin-top: 6px;
  margin-bottom: 2px;
  background-image: url('@assets/images/Tooltip_SeparatorThick.png');
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
}

.tooltip-body { font-size: 15px; padding: 0 18px 8px; }
.tooltip-body.no-title { padding-top: 8px; }

/* 固定属性：白色，居中 */
.tooltip-primary {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  color: var(--dnd-white);
  white-space: nowrap;
}
.tooltip-primary + .tooltip-primary { padding-top: 5px; }
.tooltip-primary b { font-weight: normal; }

/* 随机属性 */
.tooltip-attribute {
  display: flex;
  gap: 4px;
  justify-content: center;
  color: var(--dnd-blue);
  white-space: nowrap;
}
.tooltip-attribute b { font-weight: normal; }
.attr-sub { margin-top: 2px; font-size: 13px; color: var(--dnd-dust); white-space: nowrap; }
.affix-line1 {
  display: grid;
  grid-template-columns: 1.05em minmax(0, 1fr) 1.05em;
  column-gap: 0.5em;
  align-items: center;
}
.affix-line1 .tooltip-attribute { grid-column: 2; justify-content: center; }
.affix-check {
  grid-column: 3;
  justify-self: center;
  width: 1.05em;
  height: 1.05em;
  border-radius: 50%;
  border: 0.12em solid var(--dnd-dust);
  box-sizing: border-box;
  cursor: pointer;
}
.affix-check.on {
  background: var(--dnd-green);
  border-color: #14121a;
  border-width: 4px;
  outline: 3px solid var(--dnd-dust);
}

.tooltip-separator {
  display: block;
  width: 100%;
  height: 3px;
  margin: 6px 0;
  background-image: url('@assets/images/Tooltip_SeparatorThin.png');
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
}

.tooltip-stats { font-size: 14px; }
.tooltip-stat span:first-child {
  display: inline-block;
  margin-right: 8px;
  color: var(--dnd-dust);
}

.tooltip-prices { white-space: nowrap; }
.price-row { display: flex; align-items: center; justify-content: center; }
.price-row .ml { margin-left: 8px; }
.gold {
  display: flex;
  align-items: center;
  color: var(--dnd-gold);
}
.gold:before,
.price-empty:before {
  content: '';
  display: inline-block;
  width: 18px;
  height: 15px;
  margin-right: 4px;
  background-image: url('@assets/images/Icon_Gold.png');
  background-size: contain;
  background-repeat: no-repeat;
}
.price-empty { color: var(--dnd-dust); opacity: 0.55; }

.tooltip-footer {
  font-size: 9px;
  text-align: center;
  color: var(--dnd-oak);
}

/* 加载态 */
.spinner-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 18px;
  gap: 6px;
}
.spinner-image { width: 30px; height: 30px; animation: spin 1s linear infinite; }
.spinner-text { font-size: 13px; color: var(--dnd-dust); letter-spacing: 0.05em; }

/* 错误态 */
.error-title {
  position: relative;
  padding: 8px 0;
  font-size: 19px;
  color: #ef4444;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.error-title:after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  bottom: 0;
  height: 3px;
  background-image: url('@assets/images/Tooltip_SeparatorThick.png');
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
}
.error-message { font-size: 14px; text-align: center; color: #fecaca; line-height: 1.5; }

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
</style>
