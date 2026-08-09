import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { app } from 'electron';
import { logger } from './logger.js';
import { ROOT, RESOURCES } from './config.js';

// The backend picks a FREE port at startup instead of a fixed one, so it never
// fights over 19528 (leftover process, another tool, first-launch conflict).
// The frontend asks for the actual port via 'dnd:service-port'.
let servicePort = 19528;
let OCR_URL = `http://127.0.0.1:${servicePort}`;

// Every HTTP round-trip to the local OCR service gets a hard timeout: without
// one, a slow/busy service leaves requests hanging forever, and the shell's
// periodic calls pile up unbounded (the "gets slower after ~30 min" bug).
const FETCH_TIMEOUT_MS = 5000;

let ocrProcess = null;

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
    logger.info (`[Backend] 使用动态端口 ${servicePort}`);
  } catch (e) {
    logger.warn (`[Backend] 端口准备失败，回退默认端口 ${servicePort}: ${e.message}`);
  }
  try {
    if (await killLeftoverOcr ()) logger.info ('[Backend] 已清理残留的 ocr-service.exe');
  } catch (e) {}

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

  let cmd, args;

  if (existsSync (ocrExe)) {
    cmd = ocrExe;
    args = [];
  } else if (existsSync (serverScript)) {
    let venvPython = join (ROOT, 'ocr_env', 'Scripts', 'python.exe');
    cmd = existsSync (venvPython) ? venvPython : pythonPath;
    args = [serverScript];
  } else {
    logger.error ('[Backend] No OCR service found');
    return;
  }

  logger.info (`[Backend] Starting: ${cmd} ${args.join (' ')}`);

  ocrProcess = spawn (cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: false });

  ocrProcess.stdout.on ('data', (d) => logger.info (`[OCR] ${d.toString ().trim ()}`));
  ocrProcess.stderr.on ('data', (d) => {
    let msg = d.toString ().trim ();
    if (msg && !msg.includes ('UserWarning') && !msg.includes ('FutureWarning')) {
      logger.warn (`[OCR] ${msg}`);
    }
  });
  ocrProcess.on ('close', (code) => { logger.info (`[Backend] Exited: ${code}`); ocrProcess = null; });
  ocrProcess.on ('error', (err) => { logger.error (`[Backend] Spawn error: ${err.message}`); ocrProcess = null; });
}

export async function stopService () {
  // 先让 OCR 服务优雅停止抓包（服务内部会终止 tshark / dumpcap 子进程并清理临时文件）
  try {
    const res = await fetch (OCR_URL + '/capture/stop', { method: 'POST', signal: AbortSignal.timeout (6000) });
    if (!res.ok) logger.warn (`[Backend] Graceful stop HTTP ${res.status}`);
  } catch (e) {
    logger.warn (`[Backend] Graceful stop request failed: ${e.message}`);
  }
  // 等服务侧清理完成再退出，避免强杀导致 tshark/dumpcap 残留
  await new Promise (r => setTimeout (r, 1500));
  if (ocrProcess) {
    try { ocrProcess.kill (); } catch (e) {}
    ocrProcess = null;
  }
}

async function get (path) {
  try {
    const res = await fetch (OCR_URL + path, { signal: AbortSignal.timeout (FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json ();
  } catch (e) {
    return null;
  }
}

async function post (path, body) {
  try {
    const res = await fetch (OCR_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify (body) : undefined,
      signal: AbortSignal.timeout (FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json ();
  } catch (e) {
    return null;
  }
}

export async function health () {
  const data = await get ('/health');
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
  return await get ('/mapping/list') || { error: 'OCR service unavailable' };
}

export async function addMapping (chinese, english) {
  return await post ('/mapping/add', { chinese, english }) || { error: 'OCR service unavailable' };
}

export async function removeMapping (chinese) {
  return await post ('/mapping/remove', { chinese }) || { error: 'OCR service unavailable' };
}

// ── DnD Tools: Capture ──

export async function captureStart () {
  return await post ('/capture/start') || { error: 'Service unavailable' };
}

export async function captureStop () {
  return await post ('/capture/stop') || { error: 'Service unavailable' };
}

export async function captureRestart () {
  return await post ('/capture/restart') || { error: 'Service unavailable' };
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
  return await post ('/capture/settings', settings) || { error: 'Service unavailable' };
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
  return await post ('/stash/clear') || { error: 'Service unavailable' };
}

export async function switchStash (stashId, characterId = '') {
  return await post ('/stash/switch', { stash_id: String (stashId), character_id: String (characterId) }) || { error: 'Service unavailable' };
}

export async function getStashLocks () {
  return await get ('/stash/locks');
}

export async function setStashLock (stashId, locked) {
  return await post ('/stash/locks', { stash_id: Number (stashId), locked: !!locked }) || { error: 'Service unavailable' };
}

export async function tabTest (characterId = '') {
  return await post ('/stash/tabtest', { stash_id: '4', character_id: String (characterId) }) || { error: 'Service unavailable' };
}

export async function tabScan () {
  return await post ('/stash/tabscan') || { error: 'Service unavailable' };
}

export async function firstCalibrate () {
  return await post ('/stash/first-calibrate') || { error: 'Service unavailable' };
}

export async function followCalibrateStatus () {
  return await get ('/stash/follow-calibrate');
}

export async function followCalibrateRecord (index) {
  return await post ('/stash/follow-calibrate/record', { index }) || { error: 'Service unavailable' };
}

export async function followCalibrateAuto () {
  return await post ('/stash/follow-calibrate/auto') || { error: 'Service unavailable' };
}

export async function followCalibrateSave () {
  return await post ('/stash/follow-calibrate/save') || { error: 'Service unavailable' };
}

export async function followCalibrateReset () {
  return await post ('/stash/follow-calibrate/reset') || { error: 'Service unavailable' };
}

export async function calibrationStatus () {
  return await get ('/stash/calibration');
}

export async function calibrationRecord (index) {
  return await post ('/stash/calibration/record', { index }) || { error: 'Service unavailable' };
}

export async function calibrationSave (resolution = '') {
  return await post ('/stash/calibration/save', { resolution }) || { error: 'Service unavailable' };
}

export async function calibrationReset () {
  return await post ('/stash/calibration/reset') || { error: 'Service unavailable' };
}

// ── DnD Tools: Sort ──

export async function sortStart (params) {
  return await post ('/sort/start', params) || { error: 'Service unavailable' };
}

export async function sortAllStart (params) {
  return await post ('/sort/sort-all', params) || { error: 'Service unavailable' };
}

export async function mergeStacksStart (params) {
  return await post ('/sort/merge-stacks', params) || { error: 'Service unavailable' };
}

export async function crossSortStart (params) {
  return await post ('/sort/cross', params) || { error: 'Service unavailable' };
}

export async function preciseSortStart (params) {
  return await post ('/sort/precise', params) || { error: 'Service unavailable' };
}

export async function sortCancel () {
  return await post ('/sort/cancel') || { error: 'Service unavailable' };
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
  return await post ('/sort/speed', { value }) || { error: 'Service unavailable' };
}

export async function getSortOrder () {
  return await get ('/sort/order');
}

export async function updateSortOrder (order) {
  return await post ('/sort/order', { order }) || { error: 'Service unavailable' };
}

export async function getSortGroupMode () {
  return await get ('/sort/group-mode');
}

export async function setSortGroupMode (mode) {
  return await post ('/sort/group-mode', { mode }) || { error: 'Service unavailable' };
}

export async function getQuickPlace () {
  return await get ('/sort/quickplace');
}

export async function setQuickPlace (enabled) {
  return await post ('/sort/quickplace', { enabled: !!enabled }) || { error: 'Service unavailable' };
}

export async function getNarrowAnchor () {
  return await get ('/sort/narrow-anchor');
}

export async function setNarrowAnchor (anchor) {
  return await post ('/sort/narrow-anchor', { anchor }) || { error: 'Service unavailable' };
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
  return await post ('/packets/clear') || { error: 'Service unavailable' };
}
