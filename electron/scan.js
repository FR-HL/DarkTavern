import { ipcMain } from 'electron';
import { logger } from './logger.js';
import { settings, saveSettings } from './settings.js';
import { getCanScan, resendState } from './overlay.js';
import * as backend from './backend.js';

const DARKERDB_URL = 'https://api.darkerdb.com/v1/internal/grimvault/analyze';
const MARKET_URL = 'https://api.darkerdb.com/v2/market';

const GRADE_ORDER = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

let scanning = false;
let cache = { text: null, result: null, ts: 0 };
const CACHE_TTL = 10000;

export function wire (overlay, sendBall = null) {
  const send = (msg, data) => overlay.webContents.send (msg, data);
  const markScan = (active) => { if (sendBall) sendBall ({ active }); };
  const markResult = (data) => { if (sendBall) sendBall ({ scanResult: data }); };

  ipcMain.on ('ready', () => {
    logger.info ('Frontend ready');
    send ('settings', settings);
    resendState ();
  });

  ipcMain.on ('log', (e, data) => {
    logger.log (data.level, `[Frontend] ${data.message}`, data.meta || {});
  });

  ipcMain.on ('scan', async (e, data) => {
    const scanId = data?.scanId || 0;
    const source = data?.source || 'auto';
    if (scanning) return;
    scanning = true;
    markScan (true);

    if (source === 'manual') {
      overlay.setAlwaysOnTop (true, 'screen-saver');
      overlay.moveTop ();
      send ('scan:start', { scanId, source });
    }

    if (!getCanScan ()) {
      if (source === 'manual') send ('clear', { scanId });
      send ('scan:finish');
      scanning = false;
      markScan (false);
      return;
    }

    let tooltip = null;
    try {
      tooltip = await backend.scan ();
    } catch (err) {
      logger.error (`Scan error: ${err}`);
    }

    if (!tooltip) {
      if (source === 'manual') send ('clear', { scanId });
      send ('scan:finish');
      scanning = false;
      markScan (false);
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
      markResult ({
        ok: true,
        name: result.data?.item?.name || '',
        market: result.data?.pricing?.market ?? null,
        rarity: result.data?.item?.rarity || '',
        id: result.data?.item?.id || result.data?.item?.item_id || '',
        pricing: result.data?.pricing || null,
        attributes: {
          primary: result.data?.item?.primary || [],
          secondary: result.data?.item?.secondary || [],
        },
        reverseAttributes: result.data?.reverse_attributes || {},
      });
      queryMarketLive (result.data, scanId, (msg, payload) => {
        send (msg, payload);
        if (msg === 'hover:live-price') markResult ({ ok: true, live: payload?.price ?? null });
      });
    } else {
      send ('hover:error', {
        scanId, message: result.error,
        x: tooltip.x || 0, y: tooltip.y || 0,
        width: tooltip.width || 100, height: tooltip.height || 50,
      });
      markResult ({ ok: false, message: result.error });
    }

    send ('scan:finish');
    scanning = false;
    markScan (false);
  });

  ipcMain.handle ('backend:health', () => backend.healthRaw ());
  ipcMain.handle ('backend:window', () => backend.getWindow ());

  ipcMain.handle ('chinese:mappings', () => backend.getMappings ());
  ipcMain.handle ('chinese:add-mapping', (e, d) => backend.addMapping (d.chinese, d.english));
  ipcMain.handle ('chinese:remove-mapping', (e, d) => backend.removeMapping (d.chinese));

  ipcMain.handle ('auth:status', () => ({ linked: !!settings.general.api_key }));
  ipcMain.handle ('auth:logout', () => { settings.general.api_key = ''; saveSettings (); return { success: true }; });
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

function toCanonicalItemId (rawId) {
  if (rawId.startsWith ('id.item.')) return rawId;
  const snake = rawId.replace (/([a-z])([A-Z])/g, '$1_$2').toLowerCase ();
  return `id.item.${snake}`;
}

function attrToField (displayName) {
  return displayName.toLowerCase ().replace (/ /g, '_');
}

async function queryMarketLive (data, scanId, send) {
  let price = null;
  try {
    const itemId = toCanonicalItemId (data.item?.id || data.item?.item_id || '');
    const rarity = data.item?.rarity;
    const secondary = data.item?.secondary || [];

    if (itemId && itemId !== 'id.item.') {
      const headers = { 'User-Agent': 'DarkTavern/1.0' };
      if (settings.general.api_key) headers['X-API-Key'] = settings.general.api_key;

      const sorted = [...secondary]
        .filter (a => a.grade && a.value != null)
        .sort ((a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9));

      const gradeA = sorted.filter (a => a.grade === 'S' || a.grade === 'A');
      const gradeB = sorted.filter (a => a.grade === 'B');

      const attempts = [sorted, gradeA, gradeB, []];

      for (const attrs of attempts) {
        const params = new URLSearchParams ();
        params.set ('item_id', itemId);
        if (rarity) params.set ('rarity', rarity.toLowerCase ());
        params.set ('has_sold', 'false');
        params.set ('has_expired', 'false');
        params.set ('has_cancelled', 'false');
        params.set ('sort', 'price:asc');
        params.set ('limit', '1');

        for (const attr of attrs) {
          const field = attrToField (attr.display);
          params.set (`secondary[${field}]`, `>=${attr.value}`);
        }

        const res = await fetch (`${MARKET_URL}?${params}`, { headers, signal: AbortSignal.timeout (10000) });
        if (!res.ok) continue;

        const body = await res.json ();
        const listings = body.body;
        if (Array.isArray (listings) && listings.length > 0) {
          price = listings[0].price;
          logger.info (`[MarketLive] price=${price} (${attrs.length} attrs filtered)`);
          break;
        }
      }

      if (price === null) logger.info (`[MarketLive] no active listings`);
    }
  } catch (e) {
    logger.error (`[MarketLive] ${e.message}`);
  }
  send ('hover:live-price', { scanId, price });
}
