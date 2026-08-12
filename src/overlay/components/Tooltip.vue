<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  MOUSE_STILL_FOR_MS,
  MOUSE_WAKEUP_DISTANCE,
  EDGE_PADDING,
} from "../config.js";

import {
  onMouseStill,
  onMouseWakeup,
  setMouseSleepPosition,
} from "@/shared/lib/mouse.js";

import { modes } from "@/shared/lib/modes.js";
import { interpolateColor } from "@/shared/lib/util.js";

const props = defineProps({
  mode: {
    type: Number,
  },

  alignment: {
    type: String,
  },

  components: {
    type: Array,
  },

  debug: {
    type: Boolean,
    default: false,
  },

  showSellButtons: {
    type: Boolean,
    default: true,
  },
});

const isTooltipActive = ref(false);

const tooltipNode = ref(null);
const sellActionsNode = ref(null);
const tooltipWidth = ref(0);
const tooltipHeight = ref(0);
const tooltipVisibility = ref("hidden");

// Track scan ID to ignore stale results
const currentScanId = ref(0);

// Track loading state for spinner
const isLoading = ref(false);
const livePriceLoading = ref(false);
const errorMessage = ref(null);

// Window state for gating tooltip scans
const windowState = ref({
  canScan: false,
  visible: false,
  focused: false,
});

// Track mouse position during scan for motion compensation
const scanStartMousePos = ref({ x: 0, y: 0 });
const currentMousePos = ref({ x: 0, y: 0 });

const markerNode = ref(null);

const markerTop = ref(0);
const markerLeft = ref(0);
const markerWidth = ref(0);
const markerHeight = ref(0);

// The game bounds are necessary to determine the overlay offset since the screen
// capture provides absolute coordinates relative to the monitor the game is
// running on, not relative to the game window.
const gameBounds = ref(null);

electron.on("game:bounds", (bounds) => {
  gameBounds.value = bounds;
  logger.debug(`[COORDS] Game bounds received: x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}`);
  if (bounds.scale) {
    logger.debug(`[COORDS] DPI scale: ${bounds.scale}`);
  }
});

// Listen for window state updates to gate tooltip scanning
electron.on("game:state", (state) => {
  windowState.value = state;
  logger.debug(`Window state updated: canScan=${state.canScan}, visible=${state.visible}, focused=${state.focused}`);
});

// Chinese text data from OCR
const chineseItemName = ref('');
const chineseLines = ref([]);
const itemRarity = ref('Common');
const currentItemId = ref('');
const sellListCount = ref(0);

electron.on("sell:list-count", (data) => {
  sellListCount.value = data?.count ?? 0;
});

function sendSellAction (channel) {
  logger.info("sell action clicked", { channel, id: currentItemId.value });
  if (!currentItemId.value) return;
  electron.send (channel, {
    itemId: currentItemId.value,
    rarity: itemRarity.value,
    price: item.value.prices.live ?? item.value.prices.market ?? null,
  });
}
const reverseAttributes = ref({});
const reverseKeywords = ref({});

// Currently checked secondary affixes (display names); clicking a dot toggles the check and re-queries the live price
const selectedAffixes = ref([]);
function isAffixSelected(display) {
  return selectedAffixes.value.includes(display);
}

let requerySeq = 0;
let selectionDirty = false;

function toggleAffix(display) {
  const i = selectedAffixes.value.indexOf(display);
  if (i >= 0) selectedAffixes.value.splice(i, 1);
  else selectedAffixes.value.push(display);
  selectionDirty = true;
  livePriceLoading.value = true;
  requerySeq++;
  electron.send("market:requery", { scanId: currentScanId.value, selected: [...selectedAffixes.value], seq: requerySeq });
}

// Hovering the tooltip grabs the mouse (clickable); leaving restores click-through to the game
const TOOLTIP_HIDE_GRACE_MS = 500;
const hoveringTooltip = ref(false);
let leaveHideTimer = null;
let ignoringMouse = true;

function setIgnoreMouse(ignore) {
  if (ignoringMouse === ignore) return;
  ignoringMouse = ignore;
  electron.send("overlay:set-ignore-mouse", ignore);
}

// Hit-test the pointer against the tooltip (and the sell buttons) on every
// mousemove to toggle click-through (mouseenter/leave are unreliable under
// the forwarded click-through mode)
function updateTooltipHover(event) {
  const hit = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return (
      event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom
    );
  };
  const over = hit(tooltipNode.value) || hit(sellActionsNode.value);

  if (over) {
    hoveringTooltip.value = true;
    clearTimeout(leaveHideTimer);
    setIgnoreMouse(false);
  } else if (hoveringTooltip.value) {
    hoveringTooltip.value = false;
    setIgnoreMouse(true);
    // 移出悬浮窗立即消失（不再等 600ms 宽限）
    isTooltipActive.value = false;
  }
}

// Rarity color mapping
const rarityColors = {
  'Poor': '#808080',       // 灰色 - 粗糙
  'Common': '#ffffff',     // 白色 - 普通
  'Uncommon': '#4caf50',   // 绿色 - 优秀
  'Rare': '#2196f3',       // 蓝色 - 罕见
  'Epic': '#9c27b0',       // 紫色 - 史诗
  'Legendary': '#ff8c00',  // 橙金色 - 传说
  'Unique': '#d4c68a',     // 淡金色 - 独特
  'Artifact': '#f44336',   // 红色 - 神器/命名武器
};

function getRarityColor() {
  return rarityColors[itemRarity.value] || '#ffffff';
}

const item = ref({
  attributes: {
    primary: [],
    secondary: [],
  },

  demand: null,
  quality: null,
  // relativeQuality: null,
  // numSimilarSoldRecently: null,
  adventurePoints: null,
  // experience: null,

  quests: [],

  prices: {
    market: null,
    live: null,
    vendor: null,
  },
});

// Common English→Chinese translations for UI display
const uiTranslations = {
  // NPC merchants
  'The Collector': '收藏家',
  'Woodsman': '伐木工',
  'Treasurer': '财务官',
  'Alchemist': '炼金术士',
  'Tailor': '裁缝',
  'Leathersmith': '皮匠',
  'Armourer': '铠甲匠',
  'Weaponsmith': '武器匠',
  'Surgeon': '外科医生',
  'Santa': '圣诞老人',
  'Fortune Teller': '占卜师',
  'Goblin Merchant': '哥布林商人',
};

// Helper: translate English name back to Chinese
function toChinese(englishName) {
  return reverseAttributes.value[englishName] || reverseKeywords.value[englishName] || uiTranslations[englishName] || englishName;
}

const primary = computed(() =>
  item.value.attributes.primary.filter(
    (attribute) => attribute.min !== attribute.max,
  ),
);

// Computed property to determine if tooltip content should be shown
const shouldShowContent = computed(() => {
  // Show content if we have marker position and any active state (loading, error, or tooltip)
  return markerWidth.value > 0 && (isLoading.value || errorMessage.value !== null || isTooltipActive.value);
});

// 诊断：显示条件每次变化都留痕（定位"数据到了但不显示"）
watch(shouldShowContent, (v) => {
  logger.info(`shouldShowContent=${v}`, {
    marker: markerWidth.value,
    active: isTooltipActive.value,
    loading: isLoading.value,
    error: errorMessage.value !== null,
    bounds: gameBounds.value ? { w: gameBounds.value.width, h: gameBounds.value.height } : null,
    win: { w: window.innerWidth, h: window.innerHeight },
  });
});

// 诊断：上架按钮显示条件
watch([() => currentItemId.value, () => props.showSellButtons], () => {
  logger.info("sell buttons cond", {
    id: currentItemId.value,
    show: props.showSellButtons,
    active: isTooltipActive.value,
    loading: isLoading.value,
  });
});

// Watch for tooltip content changes to re-measure dimensions and fix position
watch([shouldShowContent, isLoading, () => item.value.prices.market, () => item.value.attributes.secondary.length], () => {
  nextTick(() => {
    if (tooltipNode.value) {
      const rect = tooltipNode.value.getBoundingClientRect();
      tooltipWidth.value = rect.width;
      tooltipHeight.value = rect.height;
    }
  });
});

// Computed property for tooltip positioning with screen boundary clamping
const PADDING = 10;
const tooltipPosition = computed(() => {
  if (!markerWidth.value || !tooltipWidth.value || !tooltipHeight.value) {
    return { left: 0, top: 0 };
  }

  // Screen dimensions
  const screenW = window.innerWidth || 1920;
  const screenH = window.innerHeight || 1080;

  // Horizontal: prefer left of marker, fallback right
  const availableLeft = markerLeft.value;
  const neededSpace = tooltipWidth.value + PADDING;
  const shouldPlaceLeft = availableLeft >= neededSpace;

  let left = shouldPlaceLeft
    ? -(tooltipWidth.value + PADDING)
    : markerWidth.value + PADDING;

  // Clamp horizontal: prevent going off right edge
  const absoluteLeft = markerLeft.value + left;
  if (absoluteLeft + tooltipWidth.value > screenW) {
    left = -(tooltipWidth.value + PADDING);
  }
  // Prevent going off left edge
  if (markerLeft.value + left < 0) {
    left = -markerLeft.value;
  }

  // Vertical: center align with marker
  let top = (markerHeight.value / 2) - (tooltipHeight.value / 2);

  // Clamp vertical: prevent going off bottom
  const absoluteTop = markerTop.value + top;
  if (absoluteTop + tooltipHeight.value > screenH) {
    top = screenH - markerTop.value - tooltipHeight.value - PADDING;
  }
  // Prevent going off top
  if (markerTop.value + top < 0) {
    top = -markerTop.value + PADDING;
  }

  // 诊断：tooltip 实际渲染位置（确认是否在窗口外）
  logger.debug("tooltip pos", {
    markerLeft: Math.round(markerLeft.value),
    markerTop: Math.round(markerTop.value),
    markerW: markerWidth.value,
    left: Math.round(left),
    top: Math.round(top),
    win: `${window.innerWidth}x${window.innerHeight}`,
  });

  return { left, top };
});

// Position the marker: attached follows tooltip coords; corner modes anchor to a fixed edge
function positionMarker(x, y, width, height) {
  const mouseDeltaX = currentMousePos.value.x - scanStartMousePos.value.x;
  const mouseDeltaY = currentMousePos.value.y - scanStartMousePos.value.y;

  if (props.alignment === "attached") {
    markerTop.value = y + mouseDeltaY;
    markerLeft.value = x + mouseDeltaX;
    markerWidth.value = width;
    markerHeight.value = height;
    return;
  }

  markerWidth.value = 1;
  markerHeight.value = 1;
  if (!gameBounds.value) return;
  switch (props.alignment) {
    case "top-right":
      markerTop.value = EDGE_PADDING;
      markerLeft.value = gameBounds.value.width - EDGE_PADDING;
      break;

    case "top-left":
      markerTop.value = EDGE_PADDING;
      markerLeft.value = EDGE_PADDING;
      break;

    case "bottom-right":
      markerTop.value = gameBounds.value.height - EDGE_PADDING;
      markerLeft.value = gameBounds.value.width - EDGE_PADDING;
      break;

    case "bottom-left":
      markerTop.value = gameBounds.value.height - EDGE_PADDING;
      markerLeft.value = EDGE_PADDING;
      break;
  }
}

const scan = (source = 'auto') => {
  if (props.mode === modes.disabled) {
    return;
  }

  // Gate scanning based on window state
  if (!windowState.value.canScan) {
    logger.debug("Scan blocked: game window not focused or not visible");
    return;
  }

  // Increment scan ID to track this scan
  const scanId = ++currentScanId.value;

  // Capture current mouse position at scan start for motion compensation
  scanStartMousePos.value = {
    x: currentMousePos.value.x,
    y: currentMousePos.value.y,
  };

  logger.debug(`Checking for tooltips (scan #${scanId})`);
  electron.send("scan", { scanId, source });
};

onMouseStill(() => {
  switch (props.mode) {
    case modes.automatic:
      scan();
      break;

    case modes.manual:
    case modes.disabled:
      break;
  }
}, MOUSE_STILL_FOR_MS);

// Mouse left the item: give a grace period to travel onto the tooltip, then hide
onMouseWakeup(() => {
  if (hoveringTooltip.value) return;
  clearTimeout(leaveHideTimer);
  leaveHideTimer = setTimeout(() => {
    if (!hoveringTooltip.value) isTooltipActive.value = false;
  }, TOOLTIP_HIDE_GRACE_MS);
}, MOUSE_WAKEUP_DISTANCE);

electron.on("scan:start", (data) => {
  errorMessage.value = null;
  isTooltipActive.value = false;

  if (data?.source === 'manual') {
    isLoading.value = true;
    markerTop.value = currentMousePos.value.y;
    markerLeft.value = currentMousePos.value.x;
    markerWidth.value = 1;
    markerHeight.value = 1;
  }
});

// Main rejected this request (another scan in flight); wait for the active one instead
electron.on("scan:dropped", ({ scanId, activeScanId }) => {
  if (scanId !== currentScanId.value) return;
  logger.debug(`Scan dropped by main (scanId ${scanId}), waiting for active scan ${activeScanId}`);
  currentScanId.value = activeScanId;
});

// Test-only: F9 in app → show a fake tooltip to verify overlay rendering (clear with F8)
electron.on("test:tooltip", () => {
  logger.info("test:tooltip received");
  errorMessage.value = null;
  isLoading.value = false;
  livePriceLoading.value = false;
  chineseItemName.value = "测试物品";
  itemRarity.value = "Epic";
  item.value.demand = 8;
  item.value.quality = null;
  item.value.adventurePoints = 25;
  item.value.quests = [{ merchant: "收藏家", title: "英雄之证", count: 3 }];
  item.value.attributes.primary = [{ display: "Strength", min: 10, max: 15 }];
  item.value.attributes.secondary = [
    { display: "Physical Damage Bonus", value: 12, min: 5, max: 20, grade: "A", is_percentage: false },
  ];
  item.value.prices.market = 500;
  item.value.prices.live = 420;
  item.value.prices.vendor = 100;
  item.value.prices.density = 50;
  selectedAffixes.value = [];
  selectionDirty = false;
  positionMarker(currentMousePos.value.x, currentMousePos.value.y, 300, 100);
  isTooltipActive.value = true;
});

electron.on("clear", (data) => {
  // Ignore stale clear events
  if (data?.scanId && data.scanId !== currentScanId.value) {
    logger.debug(`Ignoring stale clear event (scanId ${data.scanId} vs current ${currentScanId.value})`);
    return;
  }

  isTooltipActive.value = false;
  isLoading.value = false;
  errorMessage.value = null;
  hoveringTooltip.value = false;
  clearTimeout(leaveHideTimer);
  electron.send("overlay:set-ignore-mouse", true);
});

electron.on("scan:finish", () => {
  setMouseSleepPosition();
});

electron.on("manual:scan", () => {
  // Manual scan: skip canScan check, always allow
  if (props.mode === modes.disabled) return;
  const scanId = ++currentScanId.value;
  scanStartMousePos.value = { x: currentMousePos.value.x, y: currentMousePos.value.y };
  logger.debug(`Manual scan triggered (scan #${scanId})`);
  electron.send("scan", { scanId, source: 'manual' });
});

// Mouse button scanning support
let scanMouseButton = null;

electron.on("set-scan-mouse-button", (buttonName) => {
  if (buttonName === 'none') {
    scanMouseButton = null;
    logger.info('Scan mouse button cleared');
    return;
  }
  const buttonMap = {
    'mousebutton0': 0, 'mousebutton1': 1, 'mousebutton2': 2,
    'mousebutton3': 3, 'mousebutton4': 3, 'mousebutton5': 4,
  };
  scanMouseButton = buttonMap[buttonName] ?? null;
  logger.info(`Scan mouse button set: ${buttonName} → button ${scanMouseButton}`);
});

onMounted(() => {
  logger.info("Tooltip mounted");

  // Pull current window state/bounds after listeners are registered (startup race guard)
  electron.send("overlay:sync-state");

  // Listen for mouse button clicks for scanning
  window.addEventListener("mousedown", (event) => {
    if (scanMouseButton !== null && event.button === scanMouseButton) {
      event.preventDefault();
      scan();
    }
  });

  // Also listen for all mouse buttons via auxclick (covers buttons 3, 4, etc.)
  window.addEventListener("auxclick", (event) => {
    if (scanMouseButton !== null && event.button === scanMouseButton) {
      event.preventDefault();
      scan();
    }
  });

  // Track current mouse position for motion compensation during scans
  window.addEventListener("mousemove", (event) => {
    currentMousePos.value = {
      x: event.clientX,
      y: event.clientY,
    };
    updateTooltipHover(event);
  });

  // Preview: immediately show Chinese OCR text while API fetches prices
  electron.on("hover:preview", async (data) => {
    if (data.scanId !== currentScanId.value) return;

    errorMessage.value = null;

    // Store Chinese text data
    chineseItemName.value = data.chinese_item_name || '';
    itemRarity.value = data.rarity || 'Common';
    reverseAttributes.value = data.reverse_attributes || {};
    reverseKeywords.value = data.reverse_keywords || {};

    // Use pre-filtered display lines from server (metadata already stripped)
    chineseLines.value = data.display_lines || [];

    // Reset price data (will be filled by hover:item)
    item.value.prices.market = null;
    item.value.prices.density = null;
    item.value.prices.vendor = null;
    item.value.prices.live = null;
    livePriceLoading.value = true;
    item.value.demand = null;
    item.value.quality = null;
    item.value.adventurePoints = null;
    item.value.quests = [];
    item.value.attributes.primary = [];
    item.value.attributes.secondary = [];
    selectedAffixes.value = [];
    selectionDirty = false;

    // Position marker at tooltip location
    positionMarker(data.x, data.y, data.width, data.height);

    // Show preview with loading state
    isLoading.value = true;
    isTooltipActive.value = true;

    setMouseSleepPosition();
  });

  // Full data: API returned prices, update tooltip
  electron.on("hover:item", async (data) => {
    // Ignore stale scan results
    if (data.scanId !== currentScanId.value) {
      logger.debug(`Ignoring stale scan result (scanId ${data.scanId} vs current ${currentScanId.value})`);
      return;
    }

    errorMessage.value = null;

    logger.debug(`[COORDS] Tooltip from native: x=${data.x}, y=${data.y}, width=${data.width}, height=${data.height}`);
    logger.debug(`[DATA] pricing=${JSON.stringify(data.pricing)}, item=${JSON.stringify(data.item?.name)}`);

    // Null-safe access: API response fields may be missing
    const pricing = data.pricing || {};
    item.value.prices.market = pricing.market ?? null;
    item.value.prices.density = pricing.density ?? null;
    item.value.prices.vendor = pricing.vendor ?? null;

    item.value.demand = data.demand ?? null;
    item.value.quality = data.quality ?? null;
    item.value.adventurePoints = data.adventure_points ?? null;

    item.value.quests = data.quests || [];
    item.value.attributes.primary = data.item?.primary || [];
    item.value.attributes.secondary = data.item?.secondary || [];
    currentItemId.value = data.item?.id || '';
    logger.info("item id set", { id: currentItemId.value, name: data.item?.name || '' });
    selectionDirty = false;

    // Update Chinese data if not already set by preview
    if (data.chinese_item_name) {
      chineseItemName.value = data.chinese_item_name;
    }
    if (data.rarity) {
      itemRarity.value = data.rarity;
    }
    if (data.display_lines) {
      chineseLines.value = data.display_lines;
    }
    if (data.reverse_attributes) {
      reverseAttributes.value = data.reverse_attributes;
    }
    if (data.reverse_keywords) {
      reverseKeywords.value = data.reverse_keywords;
    }

    // Position marker (may already be set by preview, but update in case)
    positionMarker(data.x, data.y, data.width, data.height);

    setMouseSleepPosition();

    // Done loading, show full tooltip
    isLoading.value = false;
    isTooltipActive.value = true;
  });

  electron.on("hover:live-price", (data) => {
    if (data.scanId !== currentScanId.value) return;
    if (data.source === 'scan' && selectionDirty) return;
    if (data.seq !== undefined && data.seq !== requerySeq) return;
    item.value.prices.live = data.price ?? null;
    selectedAffixes.value = data.used_affixes || [];
    livePriceLoading.value = false;
  });

  electron.on("hover:error", async (data) => {
    // Ignore stale scan results
    if (data.scanId !== currentScanId.value) {
      logger.debug(`Ignoring stale error (scanId ${data.scanId} vs current ${currentScanId.value})`);
      return;
    }

    isLoading.value = false;
    isTooltipActive.value = false;

    // Set error message and auto-clear after 3 seconds
    errorMessage.value = data.message || "未知错误";
    setTimeout(() => { errorMessage.value = null; }, 1000);

    positionMarker(data.x, data.y, data.width || 100, data.height || 50);

    setMouseSleepPosition();
  });

});

onBeforeUnmount(() => {
  // Cleanup if needed
});

function getGradeColor(grade) {
  const colors = {
    S: "var(--dnd-unique)",
    A: "var(--dnd-legendary)",
    B: "var(--dnd-epic)",
    C: "var(--dnd-rare)",
    D: "var(--dnd-uncommon)",
    F: "var(--dnd-common)",
  };

  return colors[grade] || "inherit";
}
</script>

<template>
  <div
    ref="markerNode"
    class="absolute"
    :style="{
      // Transform: markerLeft/markerTop are exact window-relative coords from WGC
      // Position marker directly at the tooltip coordinates (no offset needed)
      transform: `translate(${markerLeft}px, ${markerTop}px)`,
    }"
  >
    <!-- Single Marker - green border on detected tooltip region (debug only) -->
    <div
      v-if="markerWidth > 0"
      id="marker"
      :class="{ 'border-2 border-green-500': props.debug }"
      :style="{
        width: `${markerWidth}px`,
        height: `${markerHeight}px`,
      }"
    ></div>

    <!-- Tooltip content - manually positioned relative to marker -->
    <transition
      enter-active-class="transition-opacity duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="shouldShowContent"
        ref="tooltipNode"
        class="absolute"
        :class="{ 'border-2 border-yellow-500': props.debug, 'tooltip-hovered': hoveringTooltip }"
        :style="{
          left: `${tooltipPosition.left}px`,
          top: `${tooltipPosition.top}px`,
        }"
      >
      <!-- Loading: show only spinner if no preview data yet -->
      <div v-if="isLoading && !isTooltipActive" id="tooltip">
        <div class="tooltip-overlay"></div>
        <div class="tooltip-content">
          <div class="spinner-wrapper">
            <img
              src="@assets/images/Loading_Img.png"
              alt="搜索中..."
              class="spinner-image"
            />
            <div class="spinner-text">搜索中...</div>
          </div>
        </div>
      </div>

      <!-- Error Tooltip -->
      <div v-else-if="errorMessage !== null" id="tooltip">
        <div class="tooltip-overlay"></div>
        <div class="tooltip-content">
          <div class="error-title-wrapper">
            <span class="error-icon">⚠</span>
            <span>错误</span>
          </div>
          <div class="tooltip-body">
            <div class="error-message">{{ errorMessage }}</div>
          </div>
        </div>
      </div>

      <!-- Regular Tooltip (also shows during preview/loading with Chinese text) -->
      <div v-else-if="isTooltipActive" id="tooltip">
        <div class="tooltip-overlay"></div>
        <div class="tooltip-content">
          <!-- Chinese item name as title, colored by rarity -->
          <div
            class="tooltip-title"
            v-if="props.components.includes('header')"
            :style="{ color: chineseItemName ? getRarityColor() : 'inherit' }"
          >
            <span v-if="chineseItemName">{{ chineseItemName }}</span>
            <span v-else>物品统计</span>
          </div>

          <div
            class="tooltip-body"
            :class="{ 'mt-3': !props.components.includes('header') }"
          >
            <!-- API data: attributes (shown after loading completes) -->
            <section
              v-if="!isLoading && props.components.includes('primary') && primary.length"
            >
              <div
                v-for="attribute in primary"
                class="[&:not(:last-child)]:pb-2"
              >
                <span v-if="attribute.min !== attribute.max"
                  >{{ toChinese(attribute.display) }} {{ attribute.min }} -
                  {{ attribute.max }}</span
                >
              </div>
              <div class="tooltip-separator"></div>
            </section>

            <section
              v-if="
                !isLoading &&
                props.components.includes('secondary') &&
                item.attributes.secondary.length
              "
            >
              <div
                v-for="attribute in item.attributes.secondary"
                class="[&:not(:last-child)]:pb-2"
              >
                <div class="affix-line1">
                  <span class="tooltip-attribute text-nowrap">
                    <span
                      >{{
                        (attribute.value > 0
                          ? "+"
                          : attribute.value < 0
                            ? "-"
                            : "") +
                        attribute.value +
                        (attribute.is_percentage ? "%" : "")
                      }}
                    </span>
                    <span>{{ toChinese(attribute.display) }}</span>
                  </span>
                  <span class="affix-check" :class="{ on: isAffixSelected(attribute.display) }" @click.stop="toggleAffix(attribute.display)"></span>
                </div>

                <div class="text-base">
                  ({{ attribute.min }} - {{ attribute.max }}) (<span
                    :style="`color: ${getGradeColor(attribute.grade)}`"
                    >{{ attribute.grade }}</span
                  >)
                </div>
              </div>
              <div class="tooltip-separator"></div>
            </section>

            <section
              v-if="
                !isLoading &&
                ((props.components.includes('demand') && item.demand) ||
                  (props.components.includes('adventure') && item.adventurePoints))
              "
            >
              <div class="tooltip-stats">
                <div v-if="props.components.includes('demand') && item.demand" class="tooltip-stat">
                  <span>需求评分:</span>
                  <span
                    :style="{ color: interpolateColor(item.demand, 10) }"
                    >{{ item.demand }} / 10</span
                  >
                </div>
                <div v-if="props.components.includes('adventure') && item.adventurePoints" class="tooltip-stat">
                  <span>冒险点数:</span>
                  <span>{{ item.adventurePoints }}</span>
                </div>
              </div>
              <div class="tooltip-separator"></div>
            </section>

            <section
              v-if="
                !isLoading &&
                props.components.includes('quests') && item.quests.length
              "
            >
              <div class="text-lg">
                <span style="color: var(--dnd-feather)">任务物品</span>

                <div v-for="quest in item.quests" class="text-nowrap">
                  <span style="color: var(--dnd-aqua)"
                    >{{ toChinese(quest.merchant) }}
                    <span style="color: var(--dnd-dust)"
                      >{{ quest.title }}:</span
                    ></span
                  >
                  <span class="ml-2">{{ quest.count }}x</span>
                </div>
              </div>
              <div class="tooltip-separator"></div>
            </section>

            <!-- Pricing section: each row gated by its own component switch -->
            <div
              class="whitespace-nowrap"
              v-if="
                props.components.includes('market') ||
                props.components.includes('live') ||
                props.components.includes('vendor') ||
                props.components.includes('density')
              "
            >
              <div class="flex items-center justify-center" v-if="props.components.includes('live')">
                <span>市场现价:</span>
                <img v-if="livePriceLoading" src="@assets/images/Loading_Img.png" alt="加载中..." class="price-spinner ml-2">
                <span v-else class="ml-2" :class="item.prices.live !== null ? 'gold' : 'price-empty'">{{ item.prices.live !== null ? item.prices.live : '暂无' }}</span>
              </div>
              <div class="flex items-center justify-center" v-if="props.components.includes('market')">
                <span>市场均价:</span>
                <img v-if="isLoading" src="@assets/images/Loading_Img.png" alt="加载中..." class="price-spinner ml-2">
                <span v-else class="ml-2" :class="item.prices.market !== null ? 'gold' : 'price-empty'">{{ item.prices.market !== null ? item.prices.market : '暂无' }}</span>
              </div>
              <div class="flex items-center justify-center" v-if="props.components.includes('vendor')">
                <span>商人回收:</span>
                <img v-if="isLoading" src="@assets/images/Loading_Img.png" alt="加载中..." class="price-spinner ml-2">
                <span v-else class="ml-2" :class="item.prices.vendor !== null ? 'gold' : 'price-empty'">{{ item.prices.vendor !== null ? item.prices.vendor : '暂无' }}</span>
              </div>
              <div class="flex items-center justify-center" v-if="props.components.includes('density')">
                <span>每格价值:</span>
                <img v-if="isLoading" src="@assets/images/Loading_Img.png" alt="加载中..." class="price-spinner ml-2">
                <span v-else class="ml-2" :class="item.prices.density !== null ? 'gold' : 'price-empty'">{{ item.prices.density !== null ? item.prices.density : '暂无' }}</span>
              </div>
            </div>

            <!-- 上架按钮：商人回收价格区下方 -->
            <div
              v-if="!isLoading && isTooltipActive && currentItemId && props.showSellButtons"
              ref="sellActionsNode"
              class="sell-actions"
            >
              <button class="sell-btn" @click="sendSellAction('sell:add-item')">{{ sellListCount > 0 ? `列表中（${sellListCount}）` : '加入列表' }}</button>
              <button class="sell-btn" :disabled="item.prices.live === null && item.prices.market === null" @click="sendSellAction('sell:start-item')">开始上架</button>
            </div>

            <div class="tooltip-separator"></div>

            <div class="text-xs" style="color: var(--dnd-oak)">
              by 7. & 方源Official | 官网: dnd.wiki
            </div>
          </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.error-title-wrapper {
  @apply py-3 text-[1.65rem] flex items-center justify-center gap-2;
  color: #ef4444;
}

.error-title-wrapper:after {
  @apply content-[''] block w-full h-1 mt-2 mb-1 absolute left-0;
  background-image: url('@assets/images/Tooltip_SeparatorThick.png');
  background-size: contain;
  background-position: center;
}

.error-icon {
  font-size: 1.5rem;
}

.error-message {
  @apply text-[1.15rem] text-center;
  color: #fecaca;
  line-height: 1.5;
}

.spinner-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px 24px;
  gap: 8px;
}

.spinner-image {
  width: 40px;
  height: 40px;
  animation: spin 1s linear infinite;
}

.spinner-text {
  font-size: 1rem;
  color: var(--dnd-dust, #c8b89a);
  letter-spacing: 0.05em;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.preview-line {
  @apply text-[1.1rem] pb-1;
  color: var(--dnd-dust, #c8b89a);
  line-height: 1.4;
}

.price-empty {
  @apply text-lg;
  color: var(--dnd-dust, #c8b89a);
  opacity: 0.55;
}

.price-spinner {
  width: 18px;
  height: 18px;
  animation: spin 1s linear infinite;
}

/* 加入列表 / 开始上架（悬浮窗内容底部，宽度自动一致） */
.sell-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  padding: 0 4px 4px;
}
.sell-btn {
  flex: 1;
  padding: 8px 0;
  font-family: 'SaintKDG_Light', sans-serif;
  font-size: 1rem;
  letter-spacing: 0.04em;
  color: var(--dnd-gold);
  background-image: url('@assets/images/Background_TooltipTexture.png');
  background-size: 100% 100%;
  background-repeat: no-repeat;
  background-position: center;
  background-color: #14121a;
  border-image-slice: 21 21 21 21;
  border-image-width: 12px 12px 12px 12px;
  border-image-outset: 0;
  border-image-repeat: stretch;
  border-image-source: url('@assets/images/Background_TooltipBorder.png');
  cursor: pointer;
  transition: filter .15s ease, color .15s ease;
}
.sell-btn:hover { color: #ffe066; filter: brightness(1.15); }
.sell-btn:disabled { opacity: .45; cursor: default; }
</style>
