import { ref, computed } from 'vue';

const invoke = (ch, d) => window.electron.invoke (ch, d);

// ── 抓包状态单例：整个应用唯一数据源 ──
// StashPane（抓包控制卡片）、StashView（首次校准）等组件统一读写这里，
// 任何组件触发了可能改变抓包状态的操作（启动/停止/首次校准）后调用
// refreshCapture ()，所有消费方立即同步，不再各自维护副本。

export const capture = ref ({ running: false, interface: '', port_range: { low: 20200, high: 20300 } });
export const tsharkPath = ref ('');
export const tsharkDetected = ref ('');
export const tsharkOk = computed (() => !!tsharkPath.value);

export async function refreshCapture () {
  try {
    const s = await invoke ('dnd:capture-status');
    if (s) {
      capture.value = s;
      // 只认解析成功的 tshark 路径，避免无效选择误显示为绿点就绪
      tsharkPath.value = s.tshark_path || '';
      tsharkDetected.value = s.tshark_detected || '';
    }
  } catch (e) {}
}
