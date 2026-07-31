/**
 * Chinese OCR Extension Module
 *
 * Manages the Python OCR service lifecycle and provides Chinese tooltip
 * scanning via the same approach as GrimVault: screen capture → DNN → OCR.
 * No DLL injection - pure screen reading.
 */

import electron from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { logger } from '../logger.js';
import { ROOT, RESOURCES } from '../config.js';

const { app } = electron;

const OCR_PORT = 19528;
const OCR_URL = `http://127.0.0.1:${OCR_PORT}`;

let ocrProcess = null;

const ocrClient = axios.create ({
  baseURL: OCR_URL,
  timeout: 30000,
});

/**
 * Start the Python OCR service as a child process.
 */
export function startService (pythonPath) {
  if (ocrProcess) {
    logger.info ('[Chinese] OCR service already running');
    return;
  }

  // When packaged, files are in resources/chinese/ (outside asar)
  // When in dev, they are in chinese/ at project root
  let chineseDir = app.isPackaged
    ? join (RESOURCES, 'chinese')
    : join (ROOT, 'chinese');

  let modelsDir = app.isPackaged
    ? join (app.getAppPath (), '..', '..', 'native', 'models')
    : join (RESOURCES, 'models');
  let mappingDir = join (chineseDir, 'mapping');

  // Check for bundled exe first, then fall back to Python script
  let ocrExe = join (chineseDir, 'ocr-service', 'ocr-service.exe');
  let serverScript = join (chineseDir, 'ocr-service', 'server.py');

  let env = { ... process.env };
  env.GRIMVAULT_TOOLTIP_MODEL = join (modelsDir, 'tooltip.onnx');
  env.GRIMVAULT_MAPPING_DIR = mappingDir;
  env.GRIMVAULT_OCR_PORT = String (OCR_PORT);

  let cmd, args;

  if (existsSync (ocrExe)) {
    cmd = ocrExe;
    args = [];
    logger.info (`[Chinese] Starting OCR service (exe): ${cmd}`);
  } else if (existsSync (serverScript)) {
    // Dev fallback: use Python venv
    let venvPython = join (ROOT, 'ocr_env', 'Scripts', 'python.exe');
    cmd = existsSync (venvPython) ? venvPython : pythonPath;
    args = [serverScript];
    logger.info (`[Chinese] Starting OCR service (Python): ${cmd} ${serverScript}`);
  } else {
    logger.error ('[Chinese] No OCR service found (exe or Python)');
    return;
  }

  try {
    ocrProcess = spawn (cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    ocrProcess.stdout.on ('data', (data) => {
      logger.info (`[Chinese OCR] ${data.toString ().trim ()}`);
    });

    ocrProcess.stderr.on ('data', (data) => {
      let msg = data.toString ().trim ();

      // PaddleOCR prints progress to stderr, filter noise
      if (msg && !msg.includes ('UserWarning') && !msg.includes ('FutureWarning')) {
        logger.warn (`[Chinese OCR] ${msg}`);
      }
    });

    ocrProcess.on ('close', (code) => {
      logger.info (`[Chinese] OCR service exited with code ${code}`);
      ocrProcess = null;
    });

    ocrProcess.on ('error', (err) => {
      logger.error (`[Chinese] Failed to start OCR service: ${err.message}`);
      ocrProcess = null;
    });
  } catch (e) {
    logger.error (`[Chinese] Error spawning OCR process: ${e.message}`);
  }
}

/**
 * Stop the Python OCR service.
 */
export function stopService () {
  if (ocrProcess) {
    logger.info ('[Chinese] Stopping OCR service');

    try {
      ocrProcess.kill ();
    } catch (e) {
      // Already dead
    }

    ocrProcess = null;
  }
}

/**
 * Check if the OCR service is healthy.
 */
export async function isAvailable () {
  try {
    let response = await ocrClient.get ('/health');
    return response.data && response.data.status === 'ok';
  } catch (e) {
    return false;
  }
}

/**
 * Scan for a tooltip using Chinese OCR.
 * Same pipeline as native getTooltip(): capture → detect → OCR → translate.
 * Returns {text, x, y, width, height} or null.
 */
export async function getTooltip () {
  try {
    let response = await ocrClient.post ('/scan');

    if (!response.data || !response.data.tooltip) {
      return null;
    }

    let tooltip = response.data.tooltip;

    if (tooltip.unmapped_terms && tooltip.unmapped_terms.length > 0) {
      logger.info (`[Chinese] ${tooltip.unmapped_terms.length} unmapped terms found`);
    }

    return {
      text: tooltip.text,
      original_text: tooltip.original_text || '',
      chinese_item_name: tooltip.chinese_item_name || '',
      rarity: tooltip.rarity || 'Common',
      display_lines: tooltip.display_lines || [],
      reverse_attributes: tooltip.reverse_attributes || {},
      reverse_keywords: tooltip.reverse_keywords || {},
      unmapped_terms: tooltip.unmapped_terms || [],
      x: tooltip.x,
      y: tooltip.y,
      width: tooltip.width,
      height: tooltip.height,
    };
  } catch (e) {
    logger.error (`[Chinese] OCR scan error: ${e.message}`);
    return null;
  }
}

/**
 * Get all translation mappings.
 */
export async function getMappings () {
  try {
    let response = await ocrClient.get ('/mapping/list');
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Add a custom Chinese → English mapping.
 */
export async function addMapping (chinese, english) {
  try {
    let response = await ocrClient.post ('/mapping/add', { chinese, english });
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Remove a custom mapping.
 */
export async function removeMapping (chinese) {
  try {
    let response = await ocrClient.post ('/mapping/remove', { chinese });
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}
