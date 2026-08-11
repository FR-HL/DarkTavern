<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RARITY_CN, rarityColor } from '@/shared/lib/rarity.js';
import { ATTR_ZH, attrField } from '@/shared/lib/stats-zh.js';

const props = defineProps ({
  item: { type: Object, default: null },
});
const emit = defineEmits ([ 'close', 'add-sell', 'remove-sell' ]);

const invoke = (channel, data) => window.electron.invoke (channel, data);

const servicePort = ref (19528);
const price = ref (null);
const priceLoading = ref (false);
const priceNote = ref ('');

const rarityCn = computed (() => props.item ? (RARITY_CN[props.item.rarity] || props.item.rarity) : '');
const rarityColorCss = computed (() => props.item ? rarityColor (props.item.rarity) : '#6e6e73');

const attrs = computed (() => {
  const sp = props.item?.sp || [];
  return sp.map (([name, value]) => {
    const field = attrField (String (name).replace (/([a-z0-9])([A-Z])/g, '$1 $2'));
    return { name: ATTR_ZH[field] || name, value };
  });
});

const iconUrl = computed (() => {
  const icon = props.item?.icon;
  if (!icon) return '';
  return `http://127.0.0.1:${servicePort.value}/stash/icon/${icon}`;
});

async function queryPrice () {
  if (!props.item) return;
  priceLoading.value = true;
  priceNote.value = '';
  try {
    const r = await invoke ('market:price', [{
      index: 0,
      item_id: props.item.item_id,
      rarity: props.item.rarity,
      // 查价用 DarkerDB 显示名词条（sp_en）；sp 为中文显示名
      sp: JSON.parse (JSON.stringify (props.item.sp_en || [])),
    }]);
    price.value = r?.results?.[0]?.price ?? null;
    if (price.value == null) priceNote.value = '无市场挂单';
  } catch (e) {
    priceNote.value = '查询失败：' + (e?.message || '未知');
  }
  priceLoading.value = false;
}

watch (() => props.item, () => {
  price.value = null;
  priceNote.value = '';
}, { immediate: true });

onMounted (async () => {
  try { servicePort.value = await invoke ('dnd:service-port'); } catch (e) {}
});
</script>

<template>
  <div v-if="item" class="idm-mask" @click.self="emit('close')">
    <div class="idm-card" :style="{ '--rc': rarityColorCss }">
      <div class="idm-head">
        <div class="idm-icon-wrap">
          <img v-if="iconUrl" class="idm-icon" :src="iconUrl" alt="" />
        </div>
        <div class="idm-title">
          <div class="idm-name">{{ item.name }}</div>
          <div class="idm-sub">
            <span class="idm-rarity" :style="{ color: rarityColorCss }">{{ rarityCn }}</span>
            <span class="idm-dim">{{ item.width }}×{{ item.height }}</span>
            <span class="idm-qty">×{{ item.quantity }}</span>
          </div>
        </div>
        <button class="btn subtle sm" @click="emit('close')">关闭</button>
      </div>

      <div class="idm-body">
        <div class="idm-sec">
          <div class="idm-sec-t">词条</div>
          <div v-if="attrs.length" class="idm-attrs">
            <div v-for="(a, i) in attrs" :key="i" class="idm-attr">
              <span class="idm-attr-name">{{ a.name }}</span>
              <span class="idm-attr-val">{{ a.value }}</span>
            </div>
          </div>
          <div v-else class="idm-empty">无词条</div>
        </div>

        <div class="idm-sec">
          <div class="idm-sec-t">价格</div>
          <div class="idm-prices">
            <div class="idm-price-row">
              <span class="idm-price-k">商人价</span>
              <span class="idm-price-v">{{ item.vendor_price ? Number (item.vendor_price).toLocaleString () + ' G' : '—' }}</span>
            </div>
            <div class="idm-price-row">
              <span class="idm-price-k">市场价</span>
              <span class="idm-price-v">
                <template v-if="price != null">{{ Number (price).toLocaleString () }} G</template>
                <template v-else>{{ priceNote || '未查询' }}</template>
              </span>
              <button class="btn sm" :disabled="priceLoading" @click="queryPrice">
                {{ priceLoading ? '查询中…' : '查询' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="idm-foot">
        <button class="btn primary sm" @click="emit('add-sell')">加入上架</button>
        <button class="btn subtle sm" @click="emit('remove-sell')">移除上架</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.idm-mask {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.45);
  display: grid; place-items: center;
}
.idm-card {
  width: 360px; max-width: 90vw;
  background: var(--card); border: 1px solid var(--line-soft); border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.35);
}
.idm-head { display: flex; align-items: center; gap: 12px; }
.idm-icon-wrap {
  width: 56px; height: 56px; flex: none;
  border-radius: 8px; overflow: hidden;
  border: 1px solid var(--rc);
  background: rgba(0,0,0,0.2);
  display: grid; place-items: center;
}
.idm-icon { width: 100%; height: 100%; object-fit: cover; }
.idm-title { flex: 1; min-width: 0; }
.idm-name { font-size: 16px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.idm-sub { margin-top: 4px; font-size: 12.5px; color: var(--text-3); display: flex; gap: 10px; }
.idm-rarity { font-weight: 700; }
.idm-body { margin-top: 14px; }
.idm-sec { margin-top: 12px; }
.idm-sec:first-child { margin-top: 0; }
.idm-sec-t { font-size: 12px; font-weight: 650; color: var(--text-3); margin-bottom: 6px; }
.idm-attrs {
  border: 1px solid var(--line-soft); border-radius: 8px; overflow: hidden;
}
.idm-attr {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; font-size: 13px;
  border-top: 1px solid var(--line-soft);
}
.idm-attr:first-child { border-top: none; }
.idm-attr-name { flex: 1; color: var(--text-2); }
.idm-attr-val { color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
.idm-empty { font-size: 12.5px; color: var(--text-3); padding: 8px 0; }
.idm-prices { border: 1px solid var(--line-soft); border-radius: 8px; overflow: hidden; }
.idm-price-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 13px;
  border-top: 1px solid var(--line-soft);
}
.idm-price-row:first-child { border-top: none; }
.idm-price-k { flex: none; color: var(--text-3); width: 56px; }
.idm-price-v { flex: 1; color: var(--gold, #F4B400); font-weight: 700; font-variant-numeric: tabular-nums; }
.idm-foot { margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end; }
</style>
