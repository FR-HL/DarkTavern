/**
 * Native module shim - DarkTavern edition.
 *
 * The original C++ addon (screen capture / DNN tooltip detection / window
 * event hooks) is FULLY replaced by the Python OCR service living in
 * chinese/ocr-service/server.py. This file only adapts the old native.* API
 * surface to plain HTTP calls into that Python service, so the upper layers
 * (main.js / pin.js / frontend.js) keep working with ZERO changes.
 *
 * Mapping:
 *   getTooltip()        -> not used (chinese/index.js already calls /scan)
 *   getGameWindow()     -> GET  /window  (bounds + monitor)
 *   getActiveWindow()   -> GET  /window  (game title or null)
 *   startWindowHooks()  -> poll /window every POLL_MS, forward as events
 *   stopWindowHooks()   -> stop the poll timer
 */

import { logger } from './logger.js';

const OCR_PORT = process.env.GRIMVAULT_OCR_PORT || '19528';
const OCR_URL = `http://127.0.0.1:${OCR_PORT}`;
const POLL_MS = 200;

let hookTimer = null;
let lastFound = null;
let lastBounds = { x: 0, y: 0, width: 0, height: 0 };
let lastMonitor = { x: 0, y: 0, width: 0, height: 0, scale: 1.0 };

async function httpGet (path) {
  try {
    const res = await fetch (OCR_URL + path);
    if (!res.ok) return null;
    return await res.json ();
  } catch (e) {
    return null;
  }
}

// Legacy native.getTooltip() fallback. The Chinese OCR service already owns
// /scan, so frontend.js never reaches this path. Kept as a harmless no-op.
async function getTooltip () {
  return undefined;
}

async function getGameWindow () {
  const data = await httpGet ('/window');
  if (!data || !data.found) return null;
  lastBounds = data.bounds;
  lastMonitor = data.monitor;
  return { bounds: data.bounds, monitor: data.monitor };
}

async function getActiveWindow () {
  const data = await httpGet ('/window');
  if (!data || !data.found) return null;
  return 'Dark and Darker';
}

function startWindowHooks (callback) {
  if (hookTimer) return true;
  logger.info ('[native-shim] window tracking via Python /window (poll ' + POLL_MS + 'ms)');

  const tick = async () => {
    const data = await httpGet ('/window');
    if (data && data.found) {
      lastBounds = data.bounds;
      lastMonitor = data.monitor;
      lastFound = true;
      callback ({
        bounds: data.bounds,
        monitor: data.monitor,
        visible: data.visible,
        focused: data.focused,
      });
    } else {
      lastFound = false;
      callback ({
        bounds: lastBounds,
        monitor: lastMonitor,
        visible: false,
        focused: false,
      });
    }
  };

  hookTimer = setInterval (tick, POLL_MS);
  tick ();
  return true;
}

function stopWindowHooks () {
  if (hookTimer) {
    clearInterval (hookTimer);
    hookTimer = null;
  }
}

export {
  getTooltip,
  getActiveWindow,
  getGameWindow,
  startWindowHooks,
  stopWindowHooks,
};
