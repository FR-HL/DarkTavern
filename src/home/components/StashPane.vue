<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const invoke = (ch, d) => window.electron.invoke (ch, d);

const error = ref ('');

const capture = ref ({ running: false, interface: '', port_range: { low: 20200, high: 20300 } });
const captureBusy = ref (false);

const interfaces = ref ([]);
const selectedIface = ref ('');
const ifaceBusy = ref (false);

const tsharkPath = ref ('');
const tsharkDetected = ref ('');
const tsharkBusy = ref (false);
const tsharkOk = computed (() => !!tsharkPath.value);

const diag = ref (null);
const diagBusy = ref (false);
const diagOpen = ref (false);

async function refreshCapture () {
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

async function pickTshark () {
  if (tsharkBusy.value) return;
  tsharkBusy.value = true;
  error.value = '';
  try {
    const res = await invoke ('dnd:pick-tshark');
    if (res && !res.canceled && res.path) {
      const r = await invoke ('dnd:capture-settings', { wireshark_path: res.path });
      if (r && r.error) error.value = r.error;
      await refreshCapture ();
      if (!tsharkOk.value) error.value = '所选路径未找到 tshark.exe，请重新选择（可直接选 Wireshark 安装目录，如 D:\\Program Files\\Wireshark）';
    }
  } finally { tsharkBusy.value = false; }
}

async function loadInterfaces () {
  try {
    const d = await invoke ('dnd:capture-interfaces');
    interfaces.value = d?.interfaces || [];
    selectedIface.value = d?.selected || capture.value.interface || '';
  } catch (e) {}
}

async function loadDiagnose () {
  diagBusy.value = true;
  try {
    diag.value = await invoke ('dnd:capture-diagnose');
  } catch (e) {}
  diagBusy.value = false;
}

const diagSummary = computed (() => {
  const d = diag.value;
  if (!d) return '检测中…';
  if (!d.game.running) return '游戏未运行 — 启动游戏后重新检测';
  const mode = d.capture?.mode;
  const proxyPort = d.capture?.proxy_port || d.accelerator?.proxy_port;
  if (mode === 'accelerator' || d.accelerator?.detected) return `检测到加速器 · 回环抓包 · 代理端口 ${proxyPort}`;
  return `未检测到加速器 · 物理网卡 ${d.capture?.interface || d.capture?.interface} 直连`;
});

const diagExternals = computed (() => {
  const d = diag.value;
  return d && d.external ? d.external.slice (0, 3) : [];
});

async function applyInterface () {
  if (!selectedIface.value || ifaceBusy.value) return;
  if (selectedIface.value === capture.value.interface) return;
  ifaceBusy.value = true;
  try {
    await invoke ('dnd:capture-settings', { interface: selectedIface.value });
    await refreshCapture ();
  } finally { ifaceBusy.value = false; }
}

async function toggleCapture () {
  captureBusy.value = true;
  error.value = '';
  try {
    if (capture.value.running) {
      await invoke ('dnd:capture-stop');
    } else {
      const r = await invoke ('dnd:capture-start');
      if (r && r.error) error.value = r.error;
    }
    await refreshCapture ();
    await loadDiagnose ();
  } finally { captureBusy.value = false; }
}

async function clearData () {
  if (!confirm ('确定清除所有已捕获的角色数据？')) return;
  await invoke ('dnd:clear-characters');
  window.dispatchEvent (new CustomEvent ('dnd:characters-refresh'));
}

let refreshTimer = null;
let ocrReady = false;

function fullRefresh () {
  refreshCapture ();
  loadInterfaces ();
  loadDiagnose ();
}

onMounted (() => {
  fullRefresh ();
  // 组件常驻（v-show）后不再随切换重建：启动时后端可能尚未就绪，
  // 用轻量轮询保证抓包状态最终一致，并在后端就绪时补一次完整刷新。
  refreshTimer = setInterval (() => {
    refreshCapture ();
    if (ocrReady && refreshTimer) { clearInterval (refreshTimer); refreshTimer = null; }
  }, 5000);
  window.electron.on ('ocr:status', (d) => {
    if (d?.ok && !ocrReady) {
      ocrReady = true;
      fullRefresh ();
    }
  });
});

onBeforeUnmount (() => {
  if (refreshTimer) { clearInterval (refreshTimer); refreshTimer = null; }
});
</script>

<template>
  <div>
    <div class="page-title">角色仓库</div>
    <div class="page-sub">捕获游戏网络数据，可视化各职业角色的仓库与背包，为自动整理提供数据。</div>

    <!-- 抓包控制 -->
    <div class="cap-card card">
      <div class="cap-row">
        <div class="cap-left">
          <span class="cap-dot" :class="{ on: capture.running }"></span>
        <div class="cap-info">
          <div class="cap-t">{{ capture.running ? '抓包运行中' : '抓包已停止' }}</div>
          <div class="cap-d" v-if="capture.mode === 'accelerator'">
            <span class="mode-tag">加速器</span> 回环抓包 · 代理端口 <span class="mono">{{ capture.proxy_port }}</span>
          </div>
          <div class="cap-d" v-else>
            端口 <span class="mono">{{ capture.port_range.low }}–{{ capture.port_range.high }}</span>
          </div>
        </div>
        </div>
        <div class="cap-iface">
          <label class="iface-label">网卡</label>
          <select v-model="selectedIface" class="iface-select" :disabled="ifaceBusy" @change="applyInterface">
            <option v-if="!interfaces.length" value="">{{ capture.interface || '检测中…' }}</option>
            <option v-for="it in interfaces" :key="it.name" :value="it.name" :disabled="!it.is_up">
              {{ it.name }} ({{ it.ip }}){{ it.is_default ? ' · 推荐' : '' }}{{ it.is_up ? '' : ' · 未连接' }}
            </option>
          </select>
        </div>
        <div class="cap-actions">
          <button class="btn subtle" @click="window.dispatchEvent (new CustomEvent ('dnd:characters-refresh'))">刷新角色</button>
          <button class="btn danger" @click="clearData">清除数据</button>
          <button class="btn" :class="capture.running ? 'warn' : 'primary'" :disabled="captureBusy" @click="toggleCapture">
            {{ capture.running ? '停止抓包' : '启动抓包' }}
          </button>
        </div>
      </div>
      <div class="cap-tshark">
        <span class="tshark-dot" :class="tsharkOk ? 'ok' : 'bad'"></span>
        <span class="tshark-label">TShark</span>
        <span class="tshark-path mono" :class="{ missing: !tsharkOk }" :title="tsharkPath || tsharkDetected">
          {{ tsharkPath || (tsharkDetected ? '未配置（检测到：' + tsharkDetected + '）' : '未找到，请选择 Wireshark 安装路径') }}
        </span>
        <button class="btn subtle sm" :disabled="tsharkBusy" @click="pickTshark">选择路径</button>
      </div>

      <div class="diag-head" :class="{ open: diagOpen }">
        <div class="diag-summary" :class="{ warn: diag && !diag.game.running }">{{ diagSummary }}</div>
        <div class="diag-actions">
          <button class="btn subtle sm" :disabled="diagBusy" @click="loadDiagnose">{{ diagBusy ? '检测中…' : '重新检测' }}</button>
          <button class="diag-toggle" :class="{ open: diagOpen }" @click="diagOpen = !diagOpen" :title="diagOpen ? '收起链路详情' : '展开链路详情'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
      </div>

      <template v-if="diagOpen">
        <div class="topo" v-if="diag">
          <!-- 游戏进程 -->
          <div class="topo-node" :class="{ dim: !diag.game.running }">
            <div class="node-ic game">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258A4 4 0 0 0 17.32 5z"/></svg>
            </div>
            <div class="node-body">
              <div class="node-name">游戏进程</div>
              <div class="node-detail mono">{{ diag.game.running ? diag.game.process + ' · PID ' + diag.game.pid : '未运行 — 请先启动游戏' }}</div>
            </div>
            <span class="node-badge" :class="diag.game.running ? 'ok' : 'off'">{{ diag.game.running ? '运行中' : '未启动' }}</span>
          </div>

          <!-- 抓包点 -->
          <div class="topo-link" :class="{ hot: diag.game.running }">
            <div class="link-rail"><span class="rail-pulse"></span></div>
            <div class="link-label">
              <span class="cap-badge">抓包点</span>
              <template v-if="diag.accelerator.detected">
                本地回环 <span class="mono">127.0.0.1</span> : <b class="mono port">{{ diag.accelerator.proxy_port }}</b>
              </template>
              <template v-else>物理网卡 <span class="mono">{{ diag.capture.interface }}</span></template>
            </div>
          </div>

          <!-- 加速器分支 -->
          <template v-if="diag.accelerator.detected">
            <div class="topo-node">
              <div class="node-ic acc">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
              <div class="node-body">
                <div class="node-name">加速器</div>
                <div class="node-detail mono">{{ diag.accelerator.process || '未知进程' }} · PID {{ diag.accelerator.pid || '—' }}</div>
              </div>
            </div>

            <div class="topo-link">
              <div class="link-rail"></div>
              <div class="link-label">外发 <span v-for="ex in diagExternals" :key="ex.remote" class="mono ext">{{ ex.local }} → {{ ex.remote }}</span><span v-if="!diagExternals.length" class="mono ext">—</span></div>
            </div>

            <div class="topo-node">
              <div class="node-ic srv">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              </div>
              <div class="node-body">
                <div class="node-name">游戏服务器</div>
                <div class="node-detail mono">{{ diagExternals.length ? diagExternals.map (e => e.remote).join (' · ') : '—' }}</div>
              </div>
            </div>
          </template>

          <!-- 直连分支 -->
          <template v-else>
            <div class="topo-node">
              <div class="node-ic srv">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              </div>
              <div class="node-body">
                <div class="node-name">游戏服务器</div>
                <div class="node-detail">直连（未检测到加速器）</div>
              </div>
            </div>
          </template>
        </div>

        <div class="diag-foot mono" v-if="diag">抓包过滤器&nbsp;&nbsp;{{ diag.capture.filter }}</div>
      </template>
    </div>

    <div v-if="error" class="status error">{{ error }}</div>
  </div>
</template>

<style scoped>
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* capture card */
.cap-card {
  display: flex; flex-direction: column;
  padding: 16px 18px; margin-bottom: 20px;
  animation: paneIn .32s var(--ease) both;
}
.cap-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cap-tshark {
  display: flex; align-items: center; gap: 9px;
  margin-top: 13px; padding-top: 13px;
  border-top: 1px solid var(--line-soft);
}
.tshark-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.tshark-dot.ok { background: var(--green); box-shadow: 0 0 0 3px var(--green-soft); }
.tshark-dot.bad { background: var(--red); box-shadow: 0 0 0 3px var(--red-soft); }
.tshark-label { font-size: 12px; font-weight: 650; color: var(--text-2); flex: none; }
.tshark-path {
  flex: 1; min-width: 0; font-size: 12px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tshark-path.missing { color: var(--red); }
.cap-left { display: flex; align-items: center; gap: 13px; }
.mode-tag {
  display: inline-block; padding: 1px 7px; margin-right: 2px;
  border-radius: var(--r-pill);
  background: var(--accent-soft); color: var(--accent);
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
}

/* ===== network topology diagnose (inside capture card) ===== */
.diag-head {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin-top: 13px; padding-top: 13px;
  border-top: 1px solid var(--line-soft);
}
.diag-actions { display: flex; align-items: center; gap: 8px; }
.diag-toggle {
  display: grid; place-items: center;
  width: 28px; height: 28px; padding: 0;
  border-radius: 8px;
  border: 1px solid var(--line); background: var(--card-2);
  color: var(--text-3); cursor: pointer;
  transition: all .18s var(--ease);
}
.diag-toggle:hover { border-color: var(--accent-soft); color: var(--accent); }
.diag-toggle svg { width: 15px; height: 15px; transition: transform .22s var(--ease); }
.diag-toggle.open svg { transform: rotate(180deg); }
.diag-summary { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; color: var(--text); }
.diag-summary.warn { color: var(--amber); }

.topo { padding: 14px 0 8px; }
.topo-node {
  display: flex; align-items: center; gap: 13px;
  padding: 9px 12px;
  border-radius: 10px;
  transition: background .18s var(--ease), transform .18s var(--ease);
}
.topo-node:hover { background: var(--card-2); transform: translateX(3px); }
.topo-node.dim { opacity: .55; }
.node-ic {
  width: 38px; height: 38px; flex: none; display: grid; place-items: center;
  border-radius: 10px; color: #fff;
  transition: transform .2s var(--ease), box-shadow .2s var(--ease);
}
.topo-node:hover .node-ic { transform: scale(1.08); }
.node-ic svg { width: 19px; height: 19px; }
.node-ic.game { background: linear-gradient(150deg, #2a8bf2, var(--accent) 50%, var(--accent-strong)); box-shadow: 0 2px 7px rgba(0,113,227,0.32); }
.node-ic.acc  { background: linear-gradient(150deg, #f5a623, #d97a00); box-shadow: 0 2px 7px rgba(217,122,0,0.32); }
.node-ic.srv  { background: linear-gradient(150deg, #34c46f, var(--green)); box-shadow: 0 2px 7px rgba(31,157,85,0.32); }
.node-body { flex: 1; min-width: 0; }
.node-name { font-size: 14px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.node-detail {
  margin-top: 2px; font-size: 11.5px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.node-badge {
  flex: none; padding: 3px 11px; border-radius: var(--r-pill);
  font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
}
.node-badge.ok  { background: var(--green-soft); color: var(--green); border: 1px solid rgba(31,157,85,0.25); }
.node-badge.off { background: var(--field-soft); color: var(--text-3); border: 1px solid var(--line-soft); }

.topo-link { display: flex; align-items: stretch; gap: 13px; padding: 0 12px; }
.link-rail { width: 38px; flex: none; display: flex; justify-content: center; position: relative; }
.link-rail::before { content: ''; width: 2px; align-self: stretch; background: var(--line); border-radius: 2px; }
.topo-link.hot .link-rail::before { background: var(--accent); opacity: .5; }
.rail-pulse {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent);
  animation: railPulse 1.6s var(--ease) infinite;
}
@keyframes railPulse {
  0%,100% { box-shadow: 0 0 0 3px var(--accent-soft); }
  50%     { box-shadow: 0 0 0 7px rgba(0,113,227,0.06); }
}
.link-label {
  flex: 1; align-self: center; display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
  padding: 7px 0; font-size: 12px; color: var(--text-3); line-height: 1.5;
}
.cap-badge {
  padding: 2px 9px; border-radius: var(--r-pill);
  background: var(--accent); color: #fff;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em;
  box-shadow: 0 1px 4px rgba(0,113,227,0.35);
}
.link-label .port { color: var(--accent); font-size: 13px; }
.link-label .ext {
  display: inline-block; padding: 2px 8px; border-radius: 6px;
  background: var(--field-soft); border: 1px solid var(--line-soft);
  font-size: 11px; color: var(--text-2);
}
.diag-foot {
  margin-top: 4px; padding: 8px 0 2px; border-top: 1px solid var(--line-soft);
  font-size: 11px; color: var(--text-3);
}
.cap-dot {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  background: var(--text-3); opacity: .4;
  transition: all .3s var(--ease);
}
.cap-dot.on { background: var(--green); opacity: 1; box-shadow: 0 0 0 4px var(--green-soft); animation: blink 1.8s var(--ease) infinite; }
.cap-t { font-size: 14.5px; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
.cap-d { margin-top: 3px; font-size: 12.5px; color: var(--text-3); }
.cap-d .mono { color: var(--text-2); font-size: 12px; }
.cap-actions { display: flex; gap: 9px; }
.btn.warn { color: var(--amber); background: var(--amber-soft); border-color: rgba(180,83,9,0.25); }
.btn.warn:hover { background: rgba(180,83,9,0.18); }

.cap-iface { display: flex; align-items: center; gap: 9px; }
.iface-label { font-size: 12px; font-weight: 600; color: var(--text-3); white-space: nowrap; }
.iface-select { width: 230px; padding: 7px 11px; font-size: 12.5px; }
.iface-select:disabled { opacity: .5; cursor: default; }
</style>
