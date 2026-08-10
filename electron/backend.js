import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { app } from 'electron';
import { logger as rootLogger } from './logger.js';
import { ROOT, RESOURCES } from './config.js';

const logger = rootLogger.child ({ module: 'backend' });

// The backend picks a FREE port at startup instead of a fixed one, so it never
// fights over 19528 (leftover process, another tool, first-launch conflict).
// The frontend asks for the actual port via 'dnd:service-port'.
let servicePort = 19528;
let OCR_URL = `http://127.0.0.1:${servicePort}`;

// 端口是否已确定（findFreePort 完成前为 false）。
// 端口未定时 get/post 直接返回 null、绝不发起请求——避免打到
// 初始占位端口 19528（旧版：启动首秒 tray 刷新请求打错端口）。
let portResolved = false;

// Every HTTP round-trip to the local OCR service gets a hard timeout: without
// one, a slow/busy service leaves requests hanging forever, and the shell's
// periodic calls pile up unbounded (the "gets slower after ~30 min" bug).
const FETCH_TIMEOUT_MS = 5000;

let ocrProcess = null;
const serviceExitListeners = new Set ();

// 注册服务退出回调（主进程用于刷新 OCR/托盘状态）
export function onServiceExit (cb) {
  serviceExitListeners.add (cb);
  return () => serviceExitListeners.delete (cb);
}

function emitServiceExit (code, signal) {
  serviceEverReady = false;
  for (const cb of serviceExitListeners) {
    try { cb (code, signal); } catch (e) {}
  }
}

// Ask the OS for a currently-free TCP port.
function findFreePort () {
  return new Promise ((resolve, reject) => {
    const srv = net.createServer ();
    srv.unref ();
    srv.on ('error', reject);
    srv.listen (0, '127.0.0.1', () => {
      const port = srv.address ().port;
      srv.close (() => resolve (port));
    });
  });
}

// Kill any leftover ocr-service.exe that survived an unclean exit. A dynamic
// port means it cannot block us, but it would keep capturing and writing to
// the same data files, so clean it up anyway. The single-instance lock means
// any ocr-service.exe present at startup is an orphan (a dev server.py runs
// under python.exe and is untouched).
function killLeftoverOcr () {
  return new Promise ((resolve) => {
    try {
      execFile ('taskkill', ['/F', '/IM', 'ocr-service.exe', '/T'], { timeout: 8000 }, (err) => {
        resolve (!err);
      });
    } catch (e) { resolve (false); }
  });
}

export async function startService (pythonPath) {
  if (ocrProcess) return;

  // Grab a free port first (fast) so the frontend can be told the real port
  // ASAP, then clean up any leftover backend so it stops capturing/writing.
  try {
    servicePort = await findFreePort ();
    OCR_URL = `http://127.0.0.1:${servicePort}`;
    portResolved = true;
    logger.info ('使用动态端口', { port: servicePort });
  } catch (e) {
    logger.warn ('端口准备失败，回退默认端口', { port: servicePort, error: e.message });
  }
  try {
    if (await killLeftoverOcr ()) logger.info ('已清理残留的 ocr-service.exe');
  } catch (e) {}

  spawnService (pythonPath);
}

// ── 服务自动重启：进程意外退出后按 3/6/12 秒退避重启，最多 3 次，
// 连续失败则放弃（崩溃循环保护）；主动 stopService 不触发。
let restartAttempts = 0;
let restartTimer = null;
let stopping = false;

function scheduleRestart () {
  if (stopping) return;
  if (restartAttempts >= 3) {
    logger.error ('查价服务进程连续退出 3 次，放弃自动重启', { attempts: restartAttempts });
    return;
  }
  const delay = [3000, 6000, 12000][restartAttempts] || 12000;
  restartAttempts++;
  logger.warn ('查价服务进程退出，将在数秒后自动重启', { attempt: restartAttempts, delayMs: delay });
  restartTimer = setTimeout (() => { restartTimer = null; spawnService (); }, delay);
}

function spawnService (pythonPath) {
  if (ocrProcess) return;
  if (stopping) return;

  let chineseDir = app.isPackaged
    ? join (RESOURCES, 'chinese')
    : join (ROOT, 'chinese');

  let modelsDir = app.isPackaged
    ? join (app.getAppPath (), '..', '..', 'native', 'models')
    : join (ROOT, 'models');

  let ocrExe = join (chineseDir, 'ocr-service', 'ocr-service.exe');
  let serverScript = join (chineseDir, 'ocr-service', 'server.py');

  let env = { ...process.env };
  env.SQUIRE_TOOLTIP_MODEL = join (modelsDir, 'tooltip.onnx');
  env.SQUIRE_REC_MODEL = join (modelsDir, 'paddle', 'ch', 'rec.onnx');
  env.SQUIRE_REC_DICT = join (modelsDir, 'paddle', 'ch', 'dict.txt');
  env.SQUIRE_MAPPING_DIR = join (chineseDir, 'mapping');
  env.SQUIRE_OCR_PORT = String (servicePort);
  // 强制 Python 子进程 stdout/stderr 以 UTF-8 输出，避免 Windows GBK 管道中文乱码
  env.PYTHONIOENCODING = 'utf-8';

  let cmd, args;

  if (existsSync (ocrExe)) {
    cmd = ocrExe;
    args = [];
  } else if (existsSync (serverScript)) {
    let venvPython = join (ROOT, 'ocr_env', 'Scripts', 'python.exe');
    cmd = existsSync (venvPython) ? venvPython : pythonPath;
    args = [serverScript];
  } else {
    logger.error ('未找到查价服务（ocr-service.exe / server.py）');
    return;
  }

  logger.info ('启动查价服务进程', { cmd, args: args.join (' ') });

  ocrProcess = spawn (cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: false });

  // Python 日志行内级别：logging 格式 [INFO]/[WARNING]/[ERROR]、uvicorn INFO: 前缀、
  // OpenCV [ WARN:0@ts] / [ERROR:0@ts] 三种，全部映射为 winston 级别
  const PY_LEVEL_RE = /(?:\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\]|^(DEBUG|INFO|WARNING|ERROR|CRITICAL):|\[\s?(WARN|ERROR|FATAL):)/;
  function pyLog (fallbackLevel, line) {
    if (!line) return;
    if (line.includes ('UserWarning') || line.includes ('FutureWarning')) return;
    const m = PY_LEVEL_RE.exec (line);
    const raw = m && (m[1] || m[2] || m[3]);
    const lvl = raw ? raw.toLowerCase () : fallbackLevel;
    if (lvl === 'error' || lvl === 'critical' || lvl === 'fatal') logger.error (line, { module: 'py' });
    else if (lvl === 'warning' || lvl === 'warn') logger.warn (line, { module: 'py' });
    else if (lvl === 'debug') logger.debug (line, { module: 'py' });
    else logger.info (line, { module: 'py' });
  }
  ocrProcess.stdout.on ('data', (d) => { for (const l of d.toString ().split ('\n')) pyLog ('info', l); });
  ocrProcess.stderr.on ('data', (d) => { for (const l of d.toString ().split ('\n')) pyLog ('warn', l); });
  ocrProcess.on ('close', (code, signal) => {
    logger.warn ('查价服务进程退出', { code, signal });
    ocrProcess = null;
    emitServiceExit (code, signal);
    scheduleRestart ();
  });
  ocrProcess.on ('error', (err) => {
    logger.error ('查价服务进程启动失败', { error: err.message });
    ocrProcess = null;
    emitServiceExit (-1, null);
    scheduleRestart ();
  });

  // spawn 成功即重置连续失败计数（真正起不来的进程会走 close/error）
  restartAttempts = 0;
}

export async function stopService () {
  stopping = true;
  if (restartTimer) { clearTimeout (restartTimer); restartTimer = null; }
  // 先让 OCR 服务优雅停止抓包（服务内部会终止 tshark / dumpcap 子进程并清理临时文件）
  try {
    const res = await fetch (OCR_URL + '/capture/stop', { method: 'POST', signal: AbortSignal.timeout (6000) });
    if (!res.ok) logger.warn ('优雅停止请求响应异常', { status: res.status });
  } catch (e) {
    logger.warn ('优雅停止请求失败', { error: e.message });
  }
  // 等服务侧清理完成再退出，避免强杀导致 tshark/dumpcap 残留
  await new Promise (r => setTimeout (r, 1500));
  if (ocrProcess) {
    try { ocrProcess.kill (); } catch (e) {}
    ocrProcess = null;
  }
}

// 连接层失败重试（服务刚启动 / 重启瞬间的 ECONNREFUSED 等）。
// 注意：超时（AbortError）绝不重试——POST 有副作用（重复触发操作），
// 且超时说明服务正忙，重试只会叠加压力。
const RETRY_ATTEMPTS = 2;
const RETRY_DELAYS = [200, 800];

// 服务是否曾就绪过：首次就绪前，连接失败是启动期的预期行为（前端并发
// 拉取状态 × 重试 = 上百条噪音），降为 debug；就绪后服务再挂才记 warn。
let serviceEverReady = false;

function fetchWithRetry (url, options, timeoutMs) {
  return (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const res = await fetch (url, { ...options, signal: AbortSignal.timeout (timeoutMs) });
        if (!res.ok) {
          if (serviceEverReady) logger.warn ('请求响应异常', { url, status: res.status, attempt });
        }
        return res;
      } catch (e) {
        if (e.name === 'AbortError') {
          if (serviceEverReady) logger.warn ('请求超时', { url, timeoutMs, attempt });
          throw e;
        }
        lastErr = e;
        if (serviceEverReady) logger.warn ('请求连接失败', { url, attempt, error: e.message, code: e?.cause?.code || e?.code });
        else logger.debug ('服务未就绪，请求暂不可用', { url, attempt, error: e.message });
        if (attempt < RETRY_ATTEMPTS) await new Promise (r => setTimeout (r, RETRY_DELAYS[attempt]));
      }
    }
    throw lastErr;
  }) ();
}

async function get (path, timeoutMs = FETCH_TIMEOUT_MS, onError = null) {
  if (!portResolved) return null; // 端口未定：不发起请求（避免打错端口）
  // 服务未就绪：除 health 探测外零发起——启动时前端并发 ~30 个请求 ×3 重试
  // = 90 次无效连接（旧版日志风暴根源）。就绪后由前端补拉机制刷新。
  if (!serviceEverReady && path !== '/health') return null;
  try {
    const res = await fetchWithRetry (OCR_URL + path, {}, timeoutMs);
    if (!res.ok) {
      if (onError) onError ({ httpStatus: res.status });
      return null;
    }
    return await res.json ();
  } catch (e) {
    if (onError) onError (e);
    return null;
  }
}

async function post (path, body, timeoutMs = FETCH_TIMEOUT_MS, onError = null) {
  if (!portResolved) return null; // 端口未定：不发起请求（避免打错端口）
  if (!serviceEverReady) return null; // 服务未就绪：零发起（同 get）
  try {
    const res = await fetchWithRetry (OCR_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify (body) : undefined,
    }, timeoutMs);
    if (!res.ok) {
      if (onError) onError ({ httpStatus: res.status });
      return null;
    }
    return await res.json ();
  } catch (e) {
    if (onError) onError (e);
    return null;
  }
}

// 把请求层失败翻译成用户能看懂的中文文案（而不是笼统的 Service unavailable）
function describeError (err) {
  if (err && err.httpStatus) return `本地服务返回异常状态（HTTP ${err.httpStatus}）`;
  if (err && err.name === 'AbortError') return '操作超时：本地服务响应过慢，请稍后重试';
  if (err) return '无法连接本地服务：后台服务未启动或正在启动，请稍后重试';
  return '本地服务未就绪，请稍后重试';
}

// POST 失败时返回带具体中文错误的对象（供前端直接展示）
async function postOrError (path, body, timeoutMs = FETCH_TIMEOUT_MS) {
  let err = null;
  const r = await post (path, body, timeoutMs, (e) => { err = e; });
  if (r) return r;
  return { success: false, error: describeError (err) };
}

// GET 失败时返回带具体中文错误的对象（供前端直接展示）
async function getOrError (path, timeoutMs = FETCH_TIMEOUT_MS) {
  let err = null;
  const r = await get (path, timeoutMs, (e) => { err = e; });
  if (r) return r;
  return { success: false, error: describeError (err) };
}

const NOT_READY_MSG = '本地服务长时间未就绪：服务启动失败或被安全软件拦截';

// 等待本地服务就绪（服务启动约 3~5 秒；启动慢时用户主动操作先自动等待）
async function waitServiceReady (timeoutMs = 20000) {
  const deadline = Date.now () + timeoutMs;
  while (Date.now () < deadline) {
    if (await health ()) return true;
    await new Promise (r => setTimeout (r, 500));
  }
  return false;
}

// 用户主动触发的长操作（校准/自动校准/切页诊断）需要等待游戏响应，
// 可能耗时 8~20 秒，不能用默认 5 秒超时（否则被掐断报 Service unavailable）。
const LONG_OP_TIMEOUT_MS = 30000;

export async function health () {
  const data = await get ('/health');
  if (data?.status === 'ok') serviceEverReady = true;
  return data?.status === 'ok';
}

export async function healthRaw () {
  return await get ('/health');
}

export async function getWindow () {
  const data = await get ('/window');
  if (!data || !data.found) return null;
  return data;
}

export async function scan () {
  const data = await post ('/scan');
  if (!data?.tooltip) return null;
  return data.tooltip;
}

export async function getMappings () {
  return await getOrError ('/mapping/list');
}

export async function addMapping (chinese, english) {
  return await postOrError ('/mapping/add', { chinese, english });
}

export async function removeMapping (chinese) {
  return await postOrError ('/mapping/remove', { chinese });
}

// ── DnD Tools: Capture ──

export async function captureStart () {
  return await postOrError ('/capture/start');
}

export async function captureStop () {
  return await postOrError ('/capture/stop');
}

export async function captureRestart () {
  return await postOrError ('/capture/restart');
}

export async function captureStatus () {
  return await get ('/capture/status');
}

export async function captureInterfaces () {
  return await get ('/capture/interfaces');
}

export async function captureDiagnose () {
  return await get ('/capture/diagnose');
}

export async function npcapStatus (force = false) {
  return await get (`/capture/npcap-status${force ? '?force=true' : ''}`);
}

export async function captureUpdateSettings (settings) {
  return await postOrError ('/capture/settings', settings);
}

// ── DnD Tools: Stash ──

export async function getCharacters () {
  return await get ('/stash/characters');
}

export async function getCurrentCharacter () {
  return await get ('/stash/current');
}

export async function getCharacter (id) {
  return await get (`/stash/character/${id}`);
}

export function getServicePort () {
  return servicePort;
}

export async function clearCharacters () {
  return await postOrError ('/stash/clear');
}

export async function switchStash (stashId, characterId = '') {
  return await postOrError ('/stash/switch', { stash_id: String (stashId), character_id: String (characterId) });
}

export async function getStashLocks () {
  return await get ('/stash/locks');
}

export async function setStashLock (stashId, locked) {
  return await postOrError ('/stash/locks', { stash_id: Number (stashId), locked: !!locked });
}

export async function tabTest (characterId = '') {
  if (!(await waitServiceReady ())) return { success: false, error: NOT_READY_MSG };
  let err = null;
  const r = await post ('/stash/tabtest', { stash_id: '4', character_id: String (characterId) }, LONG_OP_TIMEOUT_MS, (e) => { err = e; });
  if (r) return r;
  return { success: false, error: describeError (err) };
}

export async function tabScan () {
  return await postOrError ('/stash/tabscan');
}

export async function firstCalibrate () {
  // 校准前自动等待本地服务就绪（服务启动约需 3~5 秒；启动慢时点校准
  // 不再直接报错，而是等待就绪后自动执行）
  if (!(await waitServiceReady ())) {
    return {
      success: false,
      stage: 'connect',
      error: NOT_READY_MSG,
      hints: ['请检查杀毒软件是否拦截了后台服务进程', '仍无法启动时请重启软件，或联系方源并提供日志'],
    };
  }
  let err = null;
  const r = await post ('/stash/first-calibrate', undefined, LONG_OP_TIMEOUT_MS, (e) => { err = e; });
  if (r) return r;
  return { success: false, stage: 'connect', error: describeError (err), hints: ['若服务已就绪仍失败，请到「角色仓库」页查看链路诊断（游戏进程/抓包点/加速器状态）'] };
}

export async function followCalibrateStatus () {
  return await get ('/stash/follow-calibrate');
}

export async function followCalibrateRecord (index) {
  return await postOrError ('/stash/follow-calibrate/record', { index });
}

export async function followCalibrateAuto () {
  if (!(await waitServiceReady ())) return { success: false, error: NOT_READY_MSG };
  let err = null;
  const r = await post ('/stash/follow-calibrate/auto', undefined, LONG_OP_TIMEOUT_MS, (e) => { err = e; });
  if (r) return r;
  return { success: false, error: describeError (err) };
}

export async function followCalibrateSave () {
  return await postOrError ('/stash/follow-calibrate/save');
}

export async function followCalibrateReset () {
  return await postOrError ('/stash/follow-calibrate/reset');
}

export async function calibrationStatus () {
  return await get ('/stash/calibration');
}

export async function calibrationRecord (index) {
  return await postOrError ('/stash/calibration/record', { index });
}

export async function calibrationSave (resolution = '') {
  return await postOrError ('/stash/calibration/save', { resolution });
}

export async function calibrationReset () {
  return await postOrError ('/stash/calibration/reset');
}

// ── DnD Tools: Market (自动上架) ──

export async function marketCalibrationStatus () {
  return await getOrError ('/market/calibration');
}

export async function marketCalibrationRecord (key) {
  return await postOrError ('/market/calibration/arm', { key });
}

export async function marketCalibrationSave () {
  return await postOrError ('/market/calibration/save');
}

export async function marketCalibrationReset () {
  return await postOrError ('/market/calibration/reset');
}

export async function marketSell (items) {
  return await postOrError ('/market/sell', { items });
}

export async function marketStatus () {
  return await getOrError ('/market/status');
}

export async function marketCancel () {
  return await postOrError ('/market/cancel');
}

// ── DnD Tools: Sort ──

export async function sortStart (params) {
  return await postOrError ('/sort/start', params);
}

export async function sortAllStart (params) {
  return await postOrError ('/sort/sort-all', params);
}

export async function mergeStacksStart (params) {
  return await postOrError ('/sort/merge-stacks', params);
}

export async function crossSortStart (params) {
  return await postOrError ('/sort/cross', params);
}

export async function preciseSortStart (params) {
  return await postOrError ('/sort/precise', params);
}

export async function sortCancel () {
  return await postOrError ('/sort/cancel');
}

export async function sortStatus () {
  return await get ('/sort/status');
}

export async function getSortUipiStatus () {
  return await get ('/sort/uipi-status');
}

export async function getSortSpeed () {
  return await get ('/sort/speed');
}

export async function setSortSpeed (value) {
  return await postOrError ('/sort/speed', { value });
}

export async function getSortOrder () {
  return await get ('/sort/order');
}

export async function updateSortOrder (order) {
  return await postOrError ('/sort/order', { order });
}

export async function getSortGroupMode () {
  return await get ('/sort/group-mode');
}

export async function setSortGroupMode (mode) {
  return await postOrError ('/sort/group-mode', { mode });
}

export async function getQuickPlace () {
  return await get ('/sort/quickplace');
}

export async function setQuickPlace (enabled) {
  return await postOrError ('/sort/quickplace', { enabled: !!enabled });
}

export async function getNarrowAnchor () {
  return await get ('/sort/narrow-anchor');
}

export async function setNarrowAnchor (anchor) {
  return await postOrError ('/sort/narrow-anchor', { anchor });
}

export async function sortPreview (params) {
  const q = new URLSearchParams ({ character_id: params.character_id, stash_id: params.stash_id });
  if (params.stack_mode !== undefined) q.set ('stack_mode', params.stack_mode ? 'true' : 'false');
  if (params.include_inventory !== undefined) q.set ('include_inventory', params.include_inventory ? 'true' : 'false');
  if (params.keep_in_place !== undefined) q.set ('keep_in_place', params.keep_in_place ? 'true' : 'false');
  return await get (`/sort/preview?${q}`);
}

// ── DnD Tools: Packets ──

export async function getPackets (page = 0, pageSize = 50) {
  return await get (`/packets?page=${page}&page_size=${pageSize}`);
}

export async function getPacketDetail (id) {
  return await get (`/packets/${id}`);
}

export async function clearPackets () {
  return await postOrError ('/packets/clear');
}
