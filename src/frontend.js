/**
 * Frontend IPC handler - manages scan requests and API communication.
 * Routes scan through Chinese OCR service for text recognition and translation.
 */

import electron from 'electron';
import { logger } from './logger.js';
import { settings } from './settings.js';
import { getTooltip } from './native.js';
import { api } from './api.js';
import { authServer } from './authServer.js';
import { getCanScan } from './pin.js';
import * as chinese from './chinese/index.js';

const frontend = electron.ipcMain;

let isScanning = false;

// Cache: avoid repeated API calls for the same item
let lastScanCache = { text: null, result: null, timestamp: 0 };
const CACHE_TTL_MS = 10000; // 10 seconds

export function wire (overlay) {
  let send = (messageType, data) => {
    overlay.webContents.send (messageType, data);
  };

  frontend.on ('ready', () => {
    logger.info ('Frontend ready');
    send ('settings', settings);
  });

  frontend.on ('log', (event, data) => {
    logger.log (data.level, `[Frontend] ${data.message}`, data.meta || {});
  });

  // Scan handler - uses Chinese OCR service
  frontend.on ('scan', async (event, data) => {
    const scanId = data?.scanId || 0;

    if (isScanning) return;
    isScanning = true;

    // Force overlay to top layer before showing results
    overlay.setAlwaysOnTop (true, 'screen-saver');
    overlay.moveTop ();

    send ('scan:start');

    const sendError = (message, tooltip = null) => {
      send ('hover:error', {
        scanId, message,
        x: tooltip?.x || 0, y: tooltip?.y || 0,
        width: tooltip?.width || 100, height: tooltip?.height || 50
      });
    };

    if (!getCanScan ()) {
      send ('clear', { scanId });
      send ('scan:finish');
      isScanning = false;
      return;
    }

    let tooltip;

    try {
      // Always use Chinese OCR service
      tooltip = await chinese.getTooltip ();

      // Fallback to native if Chinese OCR unavailable
      if (tooltip === undefined) {
        tooltip = await getTooltip ();
      }
    } catch (e) {
      logger.error (`Scan error: ${e}`);
    }

    if (tooltip) {
      // Immediately show Chinese text preview while API loads prices
      send ('hover:preview', { scanId, ... tooltip });

      logger.info (`[Scan] Translated text: ${tooltip.text}`);

      // Check cache: skip API call if same item scanned recently
      let result;
      const now = Date.now ();

      if (lastScanCache.text === tooltip.text && (now - lastScanCache.timestamp) < CACHE_TTL_MS) {
        logger.info ('[Scan] Using cached result');
        result = lastScanCache.result;
      } else {
        result = await getItemStats (tooltip.text);
        lastScanCache = { text: tooltip.text, result, timestamp: now };
      }

      if (result.success) {
        logger.info (`[Scan] API success, pricing: ${JSON.stringify (result.data?.pricing)}`);
        send ('hover:item', { scanId, ... tooltip, ... result.data });
      } else {
        logger.warn (`[Scan] API error: ${result.error}`);
        sendError (result.error, tooltip);
      }
    } else {
      send ('clear', { scanId });
    }

    send ('scan:finish');
    isScanning = false;
  });

  frontend.handle ('auth:status', async () => {
    const hasCredentials = await authServer.hasCredentials ();
    return { linked: hasCredentials };
  });

  frontend.handle ('auth:logout', async () => {
    await authServer.clearCredentials ();
    return { success: true };
  });

  // Chinese extension IPC
  frontend.handle ('chinese:status', async () => {
    return { enabled: true, available: await chinese.isAvailable () };
  });

  frontend.handle ('chinese:mappings', async () => {
    return await chinese.getMappings ();
  });

  frontend.handle ('chinese:add-mapping', async (event, data) => {
    return await chinese.addMapping (data.chinese, data.english);
  });

  frontend.handle ('chinese:remove-mapping', async (event, data) => {
    return await chinese.removeMapping (data.chinese);
  });
}

async function getItemStats (tooltipText) {
  try {
    let response = await api.get ('/v1/internal/grimvault/analyze', {
      params: { tooltip: tooltipText }
    });

    if (!response) return { success: false, error: '服务器无响应' };
    return { success: true, data: response.data.body };
  } catch (e) {
    let errorMessage = '未知错误';

    if (e.response) {
      if (e.response.data?.errors?.length > 0) {
        // Translate common API errors to Chinese
        let apiError = e.response.data.errors[0];
        const errorMap = {
          'Failed to parse tooltip': '无法识别物品（翻译不完整）',
          'Item not found': '未找到该物品',
          'Invalid tooltip': '无效的物品信息',
          'Rate limit exceeded': '查询太频繁，请稍后',
          'Unauthorized': '未授权，请设置 API Key',
        };
        errorMessage = errorMap[apiError] || apiError;
      }
      else if (e.response.data?.status) errorMessage = e.response.data.status;
      else if (e.response.statusText) errorMessage = `${e.response.status}: ${e.response.statusText}`;
    } else if (e.message) {
      errorMessage = e.message;
    }

    return { success: false, error: errorMessage };
  }
}
