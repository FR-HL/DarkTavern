import { ipcMain } from 'electron';
import { logger } from './logger.js';
import { settings } from './settings.js';
import { getCanScan } from './overlay.js';
import * as backend from './backend.js';

const DARKERDB_URL = 'https://api.darkerdb.com/v1/internal/grimvault/analyze';

let scanning = false;
let cache = { text: null, result: null, ts: 0 };
const CACHE_TTL = 10000;

export function wire (overlay) {
  const send = (msg, data) => overlay.webContents.send (msg, data);

  ipcMain.on ('ready', () => {
    logger.info ('Frontend ready');
    send ('settings', settings);
  });

  ipcMain.on ('log', (e, data) => {
    logger.log (data.level, `[Frontend] ${data.message}`, data.meta || {});
  });

  ipcMain.on ('scan', async (e, data) => {
    const scanId = data?.scanId || 0;
    if (scanning) return;
    scanning = true;

    overlay.setAlwaysOnTop (true, 'screen-saver');
    overlay.moveTop ();
    send ('scan:start');

    if (!getCanScan ()) {
      send ('clear', { scanId });
      send ('scan:finish');
      scanning = false;
      return;
    }

    let tooltip = null;
    try {
      tooltip = await backend.scan ();
    } catch (err) {
      logger.error (`Scan error: ${err}`);
    }

    if (!tooltip) {
      send ('clear', { scanId });
      send ('scan:finish');
      scanning = false;
      return;
    }

    send ('hover:preview', { scanId, ...tooltip });
    logger.info (`[Scan] ${tooltip.text}`);

    let result;
    const now = Date.now ();
    if (cache.text === tooltip.text && (now - cache.ts) < CACHE_TTL) {
      result = cache.result;
    } else {
      result = await queryPrice (tooltip.text);
      cache = { text: tooltip.text, result, ts: now };
    }

    if (result.success) {
      send ('hover:item', { scanId, ...tooltip, ...result.data });
    } else {
      send ('hover:error', {
        scanId, message: result.error,
        x: tooltip.x || 0, y: tooltip.y || 0,
        width: tooltip.width || 100, height: tooltip.height || 50,
      });
    }

    send ('scan:finish');
    scanning = false;
  });

  ipcMain.handle ('chinese:status', async () => {
    return { enabled: true, available: await backend.health () };
  });

  ipcMain.handle ('chinese:mappings', () => backend.getMappings ());
  ipcMain.handle ('chinese:add-mapping', (e, d) => backend.addMapping (d.chinese, d.english));
  ipcMain.handle ('chinese:remove-mapping', (e, d) => backend.removeMapping (d.chinese));

  ipcMain.handle ('auth:status', () => ({ linked: !!settings.general.api_key }));
  ipcMain.handle ('auth:logout', () => { settings.general.api_key = ''; return { success: true }; });
}

async function queryPrice (tooltipText) {
  try {
    const headers = { 'User-Agent': 'DarkTavern/1.0' };
    if (settings.general.api_key) headers['X-API-Key'] = settings.general.api_key;

    const res = await fetch (`${DARKERDB_URL}?tooltip=${encodeURIComponent (tooltipText)}`, { headers, signal: AbortSignal.timeout (15000) });

    if (!res.ok) {
      const body = await res.json ().catch (() => null);
      const msg = body?.errors?.[0] || `${res.status} ${res.statusText}`;
      const errorMap = {
        'Failed to parse tooltip': '无法识别物品（翻译不完整）',
        'Item not found': '未找到该物品',
        'Invalid tooltip': '无效的物品信息',
        'Rate limit exceeded': '查询太频繁，请稍后',
        'Unauthorized': '未授权，请设置 API Key',
      };
      return { success: false, error: errorMap[msg] || msg };
    }

    const body = await res.json ();
    return { success: true, data: body.body };
  } catch (e) {
    return { success: false, error: e.message || '网络错误' };
  }
}
