<script setup>
import { onMounted, ref, watch } from "vue";
import Tooltip from "./components/Tooltip.vue";
import Popup from "./components/Popup.vue";
import { modes } from "./lib/modes.js";

const mode = ref(modes.automatic);
const popup = ref(false);
const settings = ref(null);
const isDebugging = ref(false);

let popupTimeout;

watch (mode, () => {
  popup.value = true;

  if (popupTimeout) {
    clearTimeout(popupTimeout);
  }

  popupTimeout = setTimeout(() => {
    popup.value = false;
  }, 750);
});

electron.on ('settings', (config) => {
  logger.debug (`Client received settings: ${JSON.stringify(config, null, 4)}`);
  settings.value = config;
  mode.value = modes [config.general.default_mode];
  document.documentElement.style.setProperty('--scale', config.general.scale);
});

electron.on ('manual:toggle', () => {
  switch (mode.value) {
    case modes.automatic:
      mode.value = modes.manual;
      break;

    case modes.manual:
      mode.value = modes.disabled;
      break;

    case modes.disabled:
      mode.value = modes.automatic;
      break;
  }

  logger.debug (`Changed mode to: ${mode.value}`);
});

electron.on("manual:debugger", () => {
  isDebugging.value = !isDebugging.value;
});

onMounted(() => {
  electron.send("ready");
});
</script>

<template>
  <teleport to="body">
    <div
      v-if="isDebugging"
      class="absolute bottom-0 left-0 right-0 top-0 border border-2 border-yellow-500 bg-red-500/5"
    ></div>
  </teleport>

  <div :class="{ debugging: isDebugging }" v-if="settings">
    <Tooltip
      :mode="mode"
      :alignment="settings.general.alignment"
      :components="settings.general.components"
      :debug="isDebugging"
    />

    <transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0 scale-90"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <Popup v-if="popup">
        <div>
          <span v-if="mode === modes.automatic"
            >DarkTavern
            <span class="font-bold underline">自动模式</span> 已启用
            <br />
            <span class="text-base"
              >将鼠标悬停在物品上即可自动查价</span
            ></span
          >
          <span v-if="mode === modes.manual"
            >DarkTavern
            <span class="font-bold underline">手动模式</span> 已启用
            <br />
            <span class="text-base"
              >悬停在物品上并按扫描键进行查价</span
            ></span
          >
          <span v-if="mode === modes.disabled"
            >DarkTavern <span class="font-bold underline">已禁用</span>
            <br />
            <span class="text-base"
              >重新启用前不会执行查价操作</span
            ></span
          >
        </div>

        <ul class="dotted mt-3 justify-center text-sm text-gray-300">
          <li>
            <span
              :class="{ 'text-green-500 underline': mode === modes.automatic }"
              >自动</span
            >
          </li>
          <li>
            <span :class="{ 'text-green-500 underline': mode === modes.manual }"
              >手动</span
            >
          </li>
          <li>
            <span
              :class="{ 'text-green-500 underline': mode === modes.disabled }"
              >禁用</span
            >
          </li>
        </ul>
      </Popup>
    </transition>
  </div>
</template>
