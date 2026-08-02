import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { logger } from './logger.js';
import { ROOT, RESOURCES } from './config.js';

const OCR_PORT = 19528;
const OCR_URL = `http://127.0.0.1:${OCR_PORT}`;

let ocrProcess = null;

export function startService (pythonPath) {
  if (ocrProcess) return;

  let chineseDir = app.isPackaged
    ? join (RESOURCES, 'chinese')
    : join (ROOT, 'chinese');

  let modelsDir = app.isPackaged
    ? join (app.getAppPath (), '..', '..', 'native', 'models')
    : join (ROOT, 'models');

  let ocrExe = join (chineseDir, 'ocr-service', 'ocr-service.exe');
  let serverScript = join (chineseDir, 'ocr-service', 'server.py');

  let env = { ...process.env };
  env.DARKTAVERN_TOOLTIP_MODEL = join (modelsDir, 'tooltip.onnx');
  env.DARKTAVERN_REC_MODEL = join (modelsDir, 'paddle', 'ch', 'rec.onnx');
  env.DARKTAVERN_REC_DICT = join (modelsDir, 'paddle', 'ch', 'dict.txt');
  env.DARKTAVERN_MAPPING_DIR = join (chineseDir, 'mapping');
  env.DARKTAVERN_OCR_PORT = String (OCR_PORT);

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

export function stopService () {
  if (ocrProcess) {
    try { ocrProcess.kill (); } catch (e) {}
    ocrProcess = null;
  }
}

async function get (path) {
  try {
    const res = await fetch (OCR_URL + path);
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

export async function captureUpdateSettings (settings) {
  return await post ('/capture/settings', settings) || { error: 'Service unavailable' };
}

// ── DnD Tools: Stash ──

export async function getCharacters () {
  return await get ('/stash/characters');
}

export async function getCharacter (id) {
  return await get (`/stash/character/${id}`);
}

export function getServicePort () {
  return OCR_PORT;
}

export async function clearCharacters () {
  return await post ('/stash/clear') || { error: 'Service unavailable' };
}

// ── DnD Tools: Sort ──

export async function sortStart (params) {
  return await post ('/sort/start', params) || { error: 'Service unavailable' };
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
