import { ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { logger as rootLogger } from './logger.js';
import { settings, saveSettings } from './settings.js';
import { getCanScan, resendState, activateGameWindow } from './overlay.js';
import * as backend from './backend.js';

const logger = rootLogger.child ({ module: 'scan' });

const DARKERDB_URL = 'https://api.darkerdb.com/v1/internal/grimvault/analyze';
const MARKET_URL = 'https://api.darkerdb.com/v2/market';

const GRADE_ORDER = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

let scanning = false;
let activeScanId = 0;
let cache = { text: null, result: null, ts: 0 };
const CACHE_TTL = 10000;
let lastAnalyze = null;

function hashText (t) {
  return createHash ('sha256').update (String (t || '')).digest ('hex').slice (0, 16);
}

// wire 可重建：保存当前 overlay 目标与回调，重建窗口时只更新目标不重复注册
let _overlayRef = null;
let _sendBallRef = null;
let _hooksRef = null;
let _wired = false;

export function wire (overlay, sendBall = null, hooks = null) {
  _overlayRef = overlay;
  _sendBallRef = sendBall;
  _hooksRef = hooks;
  if (_wired) return;
  _wired = true;

  const send = (msg, data) => {
    if (_overlayRef && !_overlayRef.isDestroyed ()) _overlayRef.webContents.send (msg, data);
  };
  const markScan = (active) => { if (_sendBallRef) _sendBallRef ({ active }); };
  const markResult = (data) => { if (_sendBallRef) _sendBallRef ({ scanResult: data }); };

  ipcMain.on ('ready', () => {
    logger.info ('前端就绪');
    send ('settings', settings);
    resendState ();
  });

  ipcMain.on ('overlay:sync-state', () => {
    resendState ();
  });

  ipcMain.on ('log', (e, data) => {
    logger.log (data.level, data.message, { module: 'frontend', ...(data.meta || {}) });
  });

  ipcMain.on ('scan', async (e, data) => {
    const scanId = data?.scanId || 0;
    const source = data?.source || 'auto';
    if (scanning) {
      send ('scan:dropped', { scanId, activeScanId });
      return;
    }
    scanning = true;
    activeScanId = scanId;
    markScan (true);
    const t0 = Date.now ();

    if (source === 'manual') {
      if (_overlayRef && !_overlayRef.isDestroyed ()) {
        _overlayRef.setAlwaysOnTop (true, 'screen-saver');
        _overlayRef.moveTop ();
      }
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
      logger.error ('查价扫描异常', { scanId, error: err?.message });
    }

    if (!tooltip) {
      logger.debug ('扫描无结果（未检测到提示框）', { scanId, ms: Date.now () - t0 });
      if (source === 'manual') send ('clear', { scanId });
      send ('scan:finish');
      scanning = false;
      markScan (false);
      return;
    }

    const tooltipMs = Date.now () - t0;
    send ('hover:preview', { scanId, ...tooltip });
    logger.debug ('提示框识别完成', { scanId, ms: tooltipMs, text: tooltip.text });

    const key = hashText (tooltip.text);
    const cached = _hooksRef?.findScanCache ? _hooksRef.findScanCache (key) : null;
    if (cached) {
      logger.info ('查价命中缓存', { scanId, key, id: cached.id, totalMs: Date.now () - t0 });
      const attributes = cached.attributes || { primary: [], secondary: [] };
      const pricing = { market: cached.market ?? null, vendor: cached.vendor ?? null, density: cached.density ?? null };
      lastAnalyze = {
        item: { id: cached.id, rarity: cached.rarity, primary: attributes.primary || [], secondary: attributes.secondary || [] },
        reverse_attributes: cached.reverseAttributes || {},
      };
      send ('hover:item', {
        scanId, ...tooltip,
        item: lastAnalyze.item,
        pricing,
        demand: null, quality: null, adventure_points: null, quests: [],
      });
      markResult ({ ok: true, noRecord: true, id: cached.id, name: cached.name || '', market: cached.market ?? null, rarity: cached.rarity || '', pricing, attributes, reverseAttributes: cached.reverseAttributes || {}, key });
      send ('hover:live-price', { scanId, price: cached.price ?? null, used_affixes: cached.usedAffixes || [], source: 'scan' });
      markResult ({ ok: true, noRecord: true, live: cached.price ?? null, usedAffixes: cached.usedAffixes || [] });

      send ('scan:finish');
      scanning = false;
      markScan (false);
      return;
    }

    let result;
    const now = Date.now ();
    let apiMs = 0;
    let preLiveNow = null;
    if (cache.text === tooltip.text && (now - cache.ts) < CACHE_TTL) {
      result = cache.result;
      logger.debug ('命中 10 秒短缓存', { scanId });
    } else {
      const apiStart = Date.now ();
      // 并行：识别请求 + 本地全词条现价预查（预查不依赖识别结果，只在默认 presence 模式采用）
      const headers = { 'User-Agent': 'AdventurersSquire/1.0' };
      if (settings.general.api_key) headers['X-API-Key'] = settings.general.api_key;
      const byValue = (settings.general.live_price_mode || 'presence') === 'value';
      preLiveNow = byValue ? null : buildPreLive (tooltip.text);
      const preReq = preLiveNow
        ? fetchMarketPrice (preLiveNow.id, preLiveNow.rarity, preLiveNow.attrs, byValue, headers)
            .then (p => { preLiveNow.price = p; return preLiveNow; })
            .catch (() => { preLiveNow.price = null; return preLiveNow; })
        : Promise.resolve (null);
      const [r, pre] = await Promise.all ([queryPrice (tooltip.text), preReq]);
      result = r;
      if (pre) logger.info ('现价预查完成', { itemId: pre.id, price: pre.price ?? null, attrs: pre.attrs.length });
      apiMs = Date.now () - apiStart;
      cache = { text: tooltip.text, result, ts: now };
    }

    if (result.success) {
      logger.info ('查价完成', { scanId, name: result.data?.item?.name || '', apiMs, totalMs: Date.now () - t0 });
      lastAnalyze = result.data;
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
        key,
      });
      queryMarketLive (result.data, scanId, (msg, payload) => {
        send (msg, payload);
        if (msg === 'hover:live-price') markResult ({ ok: true, live: payload?.price ?? null, usedAffixes: payload?.used_affixes || [] });
      }, preLiveNow);
    } else {
      logger.warn ('查价失败', { scanId, error: result.error, apiMs, totalMs: Date.now () - t0 });
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

  ipcMain.on ('overlay:set-ignore-mouse', (e, ignore) => {
    if (ignore) {
      if (_overlayRef && !_overlayRef.isDestroyed ()) _overlayRef.setIgnoreMouseEvents (true, { forward: true });
      activateGameWindow ();
    } else {
      if (_overlayRef && !_overlayRef.isDestroyed ()) _overlayRef.setIgnoreMouseEvents (false);
    }
  });

  let requeryTimer = null;
  ipcMain.on ('market:requery', (e, payload) => {
    const scanId = payload?.scanId || 0;
    const selected = Array.isArray (payload?.selected) ? payload.selected : [];
    if (!lastAnalyze) { send ('hover:live-price', { scanId, price: null, used_affixes: [], source: 'requery', seq: payload?.seq }); return; }

    if (requeryTimer) { clearTimeout (requeryTimer); requeryTimer = null; }
    const ms = settings.general.requery_debounce ?? 600;
    const run = async () => {
      requeryTimer = null;
      const itemId = toCanonicalItemId (lastAnalyze.item?.id || lastAnalyze.item?.item_id || '');
      const rarity = lastAnalyze.item?.rarity;
      const secondary = lastAnalyze.item?.secondary || [];
      const byValue = (settings.general.live_price_mode || 'presence') === 'value';
      const headers = { 'User-Agent': 'AdventurersSquire/1.0' };
      if (settings.general.api_key) headers['X-API-Key'] = settings.general.api_key;

      const attrs = secondary.filter (a => a.display != null && selected.includes (a.display));
      let price = null;
      if (itemId && itemId !== 'id.item.') {
        const r = await requeryLivePrice (itemId, rarity, secondary, selected, byValue, headers, _hooksRef);
        price = r.price;
      }
      send ('hover:live-price', { scanId, price, used_affixes: attrs.map (a => a.display), source: 'requery', seq: payload?.seq });
      markResult ({ ok: true, live: price ?? null, usedAffixes: attrs.map (a => a.display), newRecord: true });
    };
    if (ms <= 0) run ();
    else requeryTimer = setTimeout (run, ms);
  });
}

// 本地现价预查：OCR 文本 → 官方 id（items.json 反查）+ 全词条组合，与识别请求并行发出
// 识别回来后只有 id 与词条集合完全一致才采用（value 模式不预查，直接走原逻辑）
// 固定属性行（Weapon Damage 等）不属于词条，预查时跳过，避免与识别词条集合比较失败
const PRIMARY_DISPLAY_NAMES = new Set ([
  'Weapon Damage', 'Magical Damage', 'Magic Weapon Damage', 'Move Speed',
  'Armor Rating', 'Magic Penetration', 'Headshot Damage Reduction',
  'Max Health', 'Magic Resistance', 'Strength', 'Dexterity', 'Vigor',
  'Resourcefulness', 'Agility', 'Will', 'Knowledge', 'Memory',
]);

function buildPreLive (text) {
  try {
    if (!_hooksRef?.lookupItemKey) return null;
    const lines = String (text || '').split ('\n').map (l => l.trim ()).filter (Boolean);
    if (lines.length < 2) return null;
    const id = _hooksRef.lookupItemKey (lines[0]);
    if (!id) return null; // items.json 无此物品 → 无法预查，走原流程
    const rareLine = lines[lines.length - 1].match (/^Rarity:\s*(.*)$/i);
    const attrs = [];
    const end = rareLine ? lines.length - 1 : lines.length;
    for (let i = 1; i < end; i++) {
      const m = lines[i].match (/^[+-]?\d+(?:\.\d+)?\s+(.+)$/);
      if (!m || PRIMARY_DISPLAY_NAMES.has (m[1])) continue;
      attrs.push ({ display: m[1], value: parseFloat (lines[i]) });
    }
    return { id, rarity: rareLine ? rareLine[1] : '', attrs, price: null };
  } catch (e) {
    return null;
  }
}

function sameDisplaySet (attrs, secondary) {
  const a = new Set ((attrs || []).map (x => x.display));
  const b = new Set ((secondary || []).map (x => x.display));
  if (a.size !== b.size) return false;
  for (const d of a) if (!b.has (d)) return false;
  return true;
}

export async function analyzeByText (tooltipText) {
  try {
    const headers = { 'User-Agent': 'AdventurersSquire/1.0' };
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

async function queryPrice (tooltipText) {
  return analyzeByText (tooltipText);
}

export function toCanonicalItemId (rawId) {
  const s = String (rawId || '').replace (/^DesignDataItem:Id_Item_/, '');
  const m = s.match (/^id\.item\.(.*)$/i);
  const body = m ? m[1] : s;
  const snake = body.replace (/([a-z])([A-Z])/g, '$1_$2').toLowerCase ();
  return `id.item.${snake}`;
}

function attrToField (displayName) {
  return displayName.toLowerCase ().replace (/ /g, '_');
}

export async function fetchMarketPrice (itemId, rarity, attrs, byValue, headers) {
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
    params.set (`secondary[${field}]`, byValue ? `>=${attr.value}` : '>=0');
  }

  // 手动 AbortController 兜底：请求 10 秒未完成即放弃（AbortSignal.timeout 在部分环境失效）
  const ac = new AbortController ();
  const timer = setTimeout (() => ac.abort (), 10000);
  let res;
  try {
    res = await fetch (`${MARKET_URL}?${params}`, { headers, signal: ac.signal });
  } catch (e) {
    logger.warn ('市场现价查询超时/失败', { itemId, rarity, error: e?.name || e?.message });
    return null;
  } finally {
    clearTimeout (timer);
  }
  if (!res.ok) {
    logger.warn ('市场现价查询失败', { itemId, rarity, status: res.status });
    return null;
  }

  const listings = (await res.json ()).body;
  if (Array.isArray (listings) && listings.length > 0) return listings[0].price;
  return null;
}

// 现价查询（游戏内悬浮窗与软件内查价共用同一逻辑）：
// 全部词条按评分排序 → S/A 级 → B 级 → 无词条，四级降级，由 live_price_relax 控制
// opts.skipFirst：预查已试过全词条组合（无货）→ 从 S/A 级直接开始，避免重复请求
export async function fetchMarketLivePrice (itemId, rarity, secondary, byValue, headers, opts = {}) {
  const sorted = [...secondary]
    .filter (a => a.grade && a.value != null)
    .sort ((a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9));

  const gradeA = sorted.filter (a => a.grade === 'S' || a.grade === 'A');
  const gradeB = sorted.filter (a => a.grade === 'B');

  const relaxDepth = { all: 0, sa: 1, b: 2, none: 3 } [settings.general.live_price_relax || 'none'] ?? 3;
  let attempts = [sorted, gradeA, gradeB, []].slice (0, relaxDepth + 1);
  if (opts.skipFirst) attempts = attempts.slice (1);

  for (const attrs of attempts) {
    const p = await fetchMarketPrice (itemId, rarity, attrs, byValue, headers);
    if (p !== null) {
      logger.info (`[MarketLive] price=${p} (${attrs.length} attrs filtered)`);
      return { price: p, attrs };
    }
  }
  logger.info (`[MarketLive] no active listings`);
  return { price: null, attrs: [] };
}

// 切词条重查（游戏内悬浮窗与软件内共用同一逻辑）：
// 只查勾选组合，无降级；命中词条组合缓存直接复用
export async function requeryLivePrice (itemId, rarity, secondary, selected, byValue, headers, hooks) {
  const attrs = secondary.filter (a => a.display != null && selected.includes (a.display));
  const ckey = hooks?.affixKey
    ? hooks.affixKey (itemId, rarity, attrs.map (a => a.display))
    : '';
  const cached = ckey && hooks?.findScanCache ? hooks.findScanCache (ckey) : null;
  if (cached && cached.price != null) {
    logger.info ('[MarketRequery] 命中词条组合缓存', { key: ckey, price: cached.price });
    return { price: cached.price, attrs, cached: true };
  }
  try {
    const price = await fetchMarketPrice (itemId, rarity, attrs, byValue, headers);
    return { price, attrs, cached: false };
  } catch (err) {
    logger.error (`[MarketRequery] ${err.message}`);
    return { price: null, attrs, cached: false };
  }
}

// 统一查价核心：游戏内悬浮窗与软件内查价共用同一函数
// 输入英文工具提示文本 → analyze（词条+评分+均价/回收/每格）→ 现价（按评分四级降级）
// 所有查价配置（live_price_relax / live_price_mode）都在此函数内生效，两端天然一致
export async function queryItemPrice (tooltipText) {
  const analysis = await analyzeByText (tooltipText);
  if (!analysis.success) return { ok: false, error: analysis.error };
  const headers = { 'User-Agent': 'AdventurersSquire/1.0' };
  if (settings.general.api_key) headers['X-API-Key'] = settings.general.api_key;
  const data = analysis.data;
  const item = data.item || {};
  const itemId = toCanonicalItemId (item.id || item.item_id || '');
  const byValue = (settings.general.live_price_mode || 'presence') === 'value';
  const live = itemId && itemId !== 'id.item.'
    ? await fetchMarketLivePrice (itemId, item.rarity || '', item.secondary || [], byValue, headers)
    : { price: null, attrs: [] };
  return { ok: true, data, itemId, live };
}

async function queryMarketLive (data, scanId, send, preLive) {
  let price = null;
  let usedAttrs = [];
  try {
    const itemId = toCanonicalItemId (data.item?.id || data.item?.item_id || '');
    const rarity = data.item?.rarity;
    const secondary = data.item?.secondary || [];

    if (itemId && itemId !== 'id.item.') {
      const headers = { 'User-Agent': 'AdventurersSquire/1.0' };
      if (settings.general.api_key) headers['X-API-Key'] = settings.general.api_key;
      const byValue = (settings.general.live_price_mode || 'presence') === 'value';

      // 预查采用：id 一致 + 词条集合完全一致 → 现价 = 预查结果（等价降级链第一层命中）
      if (preLive && preLive.id === itemId && sameDisplaySet (preLive.attrs, secondary)) {
        if (preLive.price != null) {
          logger.info (`[MarketLive] 预查命中 price=${preLive.price} (${preLive.attrs.length} attrs)`);
          price = preLive.price;
          usedAttrs = preLive.attrs;
        } else {
          // 预查已试过全词条组合（无货）→ 降级链从 S/A 级开始，不重复请求
          const r = await fetchMarketLivePrice (itemId, rarity, secondary, byValue, headers, { skipFirst: true });
          price = r.price;
          usedAttrs = r.attrs;
        }
      } else {
        const r = await fetchMarketLivePrice (itemId, rarity, secondary, byValue, headers);
        price = r.price;
        usedAttrs = r.attrs;
      }
    }
  } catch (e) {
    logger.error (`[MarketLive] ${e.message}`);
  }
  send ('hover:live-price', { scanId, price, used_affixes: usedAttrs.map (a => a.display), source: 'scan' });
}
