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
    : join (RESOURCES, 'models');

  let ocrExe = join (chineseDir, 'ocr-service', 'ocr-service.exe');
  let serverScript = join (chineseDir, 'ocr-service', 'server.py');

  let env = { ...process.env };
  env.GRIMVAULT_TOOLTIP_MODEL = join (modelsDir, 'tooltip.onnx');
  env.GRIMVAULT_MAPPING_DIR = join (chineseDir, 'mapping');
  env.GRIMVAULT_OCR_PORT = String (OCR_PORT);

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
