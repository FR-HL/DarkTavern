import './migrate.js';
import electron, { globalShortcut, Menu, screen, shell, Tray } from 'electron';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire (import.meta.url);
import { logger, logPath } from './logger.js';
import { ROOT, SOURCE, dataDir } from './config.js';
import { settings, saveSettings, toComponents, toDays, toDebounce } from './settings.js';
import { startTracking, stopTracking, getCanScan, setOnStateChange } from './overlay.js';
import { wire } from './scan.js';
import * as backend from './backend.js';

const { app, BrowserWindow, ipcMain, dialog } = electron;

let debugging = false;
let homeWindow = null;
let tray = null;
let healthTimer = null;
let pendingPane = null;
let previousScanAccelerator = null;
let ocrStatus = false;
const RESERVED_KEYS = ['F5', 'F6', 'F7', 'F8'];

// ── 悬浮球状态 ──
let ballWindow = null;
let ballLocked = !!settings.general.ball_locked;
let ballVisible = !!settings.general.ball_visible;
let ballScanning = false;
let ballStatusTimer = null;
let lastBallStatus = null;
let lastBallSave = 0;
let ballDrag = null;
let ballDragTimer = null;
let lastCharKey = '';
let lastSortRunning = false;
let sessionScanCount = 0;
let lastStashKey = '';
let frontStash = null;
let frontStashList = [];
let stashJustChanged = false;
let calibrateRunning = false;
let calibrateJustFinished = false;
let calibrateOk = false;
let lastScan = { ok: null, name: '', price: null, market: null, rarity: '', id: '', zhName: '', pricing: null, attributes: { primary: [], secondary: [] }, reverseAttributes: {}, message: '', ts: 0 };
const BALL_SIZE = { w: 82, h: 82 };

process.on ('uncaughtException', (e) => logger.error ('Uncaught Exception:', e));
process.on ('unhandledRejection', (r) => logger.error (`Unhandled Rejection: ${r}`));
process.on ('SIGTERM', () => process.exit (0));
process.on ('SIGINT', () => process.exit (0));

// ── Exit / crash diagnostics: record WHY the app goes down, so a future
//    "flash quit" can be diagnosed from the log instead of guessed. ──
app.on ('quit', (e, exitCode) => logger.info (`[App] quit (exitCode=${exitCode})`));
app.on ('render-process-gone', (e, wc, details) =>
  logger.error (`[App] render-process-gone: reason=${details?.reason} exitCode=${details?.exitCode}`));
app.on ('child-process-gone', (e, details) =>
  logger.error (`[App] child-process-gone: type=${details?.type} reason=${details?.reason}`));

app.commandLine.appendSwitch ('high-dpi-support', 1);
app.commandLine.appendSwitch ('force-device-scale-factor', 1);
app.commandLine.appendSwitch ('disable-crash-reporter');
app.commandLine.appendSwitch ('proxy-bypass-list', '127.0.0.1;localhost;<local>');

if (settings.general.launch_on_startup) {
  app.setLoginItemSettings ({
    openAtLogin: true,
    path: process.execPath,
    args: ['--processStart', `${basename (process.execPath)}`, '--process-start-args', '--hidden']
  });
} else {
  app.setLoginItemSettings ({ openAtLogin: false });
}

if (!app.requestSingleInstanceLock ()) app.quit ();
app.on ('second-instance', () => {
  // Already running in the background: surface the existing window instead of
  // silently quitting the new instance (which looked like a "flash quit").
  openHomeWindow ();
});

let quitCleanupDone = false;

app.on ('before-quit', () => {
  globalShortcut.unregisterAll ();
  if (healthTimer) { clearInterval (healthTimer); healthTimer = null; }
  if (ballStatusTimer) { clearInterval (ballStatusTimer); ballStatusTimer = null; }
  if (ballDragTimer) { clearInterval (ballDragTimer); ballDragTimer = null; }
  if (historySaveTimer) {
    clearTimeout (historySaveTimer);
    historySaveTimer = null;
    if (historyDirty) { historyDirty = false; saveHistory (); }
  }
  stopTracking ();
});

app.on ('will-quit', (e) => {
  // 先优雅停止 OCR 服务（含抓包清理），完成后再真正退出，避免 tshark/dumpcap 残留
  if (quitCleanupDone) return;
  e.preventDefault ();
  backend.stopService ().finally (() => { quitCleanupDone = true; app.quit (); });
});

app.on ('ready', async () => {
  backend.startService (settings.general.python_path);

  tray = new Tray (join (ROOT, 'assets/images/icon.ico'));
  tray.setToolTip ('冒险者侍从 Adventurer’s Squire');
  // 左键单击托盘图标 = 打开主页（老版本未绑定，单击无反应）
  tray.on ('click', () => openHomeWindow ());
  refreshTrayMenu ();
  healthTimer = setInterval (() => {
    refreshTrayMenu ();
    if (ocrStatus && healthTimer) { clearInterval (healthTimer); healthTimer = null; }
  }, 3000);

  setOnStateChange ((gameOk) => {
    refreshTrayMenu ();
    if (homeWindow) homeWindow.webContents.send ('game:status', { found: gameOk });
    pushBallStatus ();
  });

  let overlay = new BrowserWindow ({
    backgroundColor: '#00000000',
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    type: 'toolbar',
    webPreferences: {
      preload: join (SOURCE, 'preload.cjs'),
      sandbox: false,
      backgroundThrottling: true,
    },
  });

  overlay.webContents.setZoomFactor (1);
  overlay.loadFile (join (ROOT, 'dist', 'overlay', 'index.html'));

  startTracking (overlay);
  wire (overlay, (data) => {
    if (data?.active !== undefined) {
      ballScanning = !!data.active;
      pushBallStatus ();
    }
    if (data?.scanResult) {
      const r = data.scanResult;
      const isNewScan = r.id !== undefined;
      lastScan.ok = !!r.ok;
      if (r.name !== undefined) lastScan.name = r.name;
      if (r.live !== undefined) lastScan.price = r.live;
      if (r.market !== undefined) lastScan.market = r.market;
      if (r.rarity !== undefined) lastScan.rarity = r.rarity;
      if (r.pricing !== undefined) lastScan.pricing = r.pricing;
      if (r.attributes !== undefined) lastScan.attributes = r.attributes;
      if (r.reverseAttributes !== undefined) lastScan.reverseAttributes = r.reverseAttributes;
      if (r.usedAffixes !== undefined) lastScan.usedAffixes = r.usedAffixes;
      if (r.key !== undefined) lastScan.key = r.key;
      if (r.message !== undefined) lastScan.message = r.message;
      if (isNewScan) {
        lastScan.id = r.id;
        lastScan.ts = Date.now ();
        sessionScanCount++;
      } else if (r.newRecord) {
        lastScan.ts = Date.now ();
      }
      lastScan.zhName = findZhName (lastScan.id);
      if (lastScan.ok && lastScan.id && !r.noRecord) upsertHistoryRecord ();
      sendBallScanResult ();
    }
  }, { findScanCache });

  globalShortcut.register ('F5', () => openSettingsWindow ('settings'));
  globalShortcut.register ('F6', () => openSettingsWindow ('mapping'));
  globalShortcut.register ('F7', () => {
    overlay.webContents.send ('manual:debugger');
    debugging = !debugging;
    debugging ? overlay.webContents.openDevTools ({ mode: 'detach' }) : overlay.webContents.closeDevTools ();
  });
  globalShortcut.register ('F8', () => overlay.webContents.send ('clear'));

  registerScanHotkey (overlay);
  registerSortHotkeys ();

  // ── 悬浮球 IPC ──

  ipcMain.handle ('ball:get-status', () => gatherBallStatus ());
  ipcMain.handle ('ball:menu', () => popupBallMenu ());
  ipcMain.handle ('ball:open-home', () => openHomeWindow ());
  ipcMain.handle ('ball:open-settings', () => openSettingsWindow ('settings'));

  ipcMain.handle ('ball:drag-start', () => {
    if (!ballWindow || ballWindow.isDestroyed ()) return;
    const cursor = initBallCursor ();
    const startPos = cursor ? cursor.pos () : null;
    if (!startPos) return;
    const [wx, wy] = ballWindow.getPosition ();
    ballDrag = { wx, wy, cx: startPos.x, cy: startPos.y, moved: false, cursor };
    if (ballDragTimer) clearInterval (ballDragTimer);

    ballDragTimer = setInterval (() => {
      if (!ballDrag || !ballWindow || ballWindow.isDestroyed ()) return;
      const cur = ballDrag.cursor ? ballDrag.cursor.pos () : screen.getCursorScreenPoint ();
      if (!cur) return;
      const dx = cur.x - ballDrag.cx;
      const dy = cur.y - ballDrag.cy;
      if (!ballDrag.moved && Math.abs (dx) + Math.abs (dy) > 3) ballDrag.moved = true;
      if (ballDrag.moved) ballWindow.setPosition (Math.round (ballDrag.wx + dx), Math.round (ballDrag.wy + dy));

      // 兜底：左键已松开但 mouseup 事件丢失（拖出窗口/失焦等）→ 远程结束拖拽
      if (ballDrag.cursor && !ballDrag.cursor.leftDown ()) {
        const moved = ballDrag.moved;
        if (ballDragTimer) { clearInterval (ballDragTimer); ballDragTimer = null; }
        ballDrag = null;
        saveBallPos ();
        if (ballWindow && !ballWindow.isDestroyed ()) ballWindow.webContents.send ('ball:drag-ended', { moved });
      }
    }, 16);
  });
  ipcMain.handle ('ball:drag-end', () => {
    const moved = ballDrag?.moved || false;
    if (ballDragTimer) { clearInterval (ballDragTimer); ballDragTimer = null; }
    ballDrag = null;
    saveBallPos ();
    return { moved };
  });

  try {
    globalShortcut.register ('CommandOrControl+Alt+B', () => setBallLocked (!ballLocked));
    logger.info ('Ball lock hotkey: Ctrl+Alt+B');
  } catch (e) {
    logger.error (`Failed to register ball lock hotkey: ${e.message}`);
  }

  // ── 前端仓库页状态与切换 ──

  ipcMain.handle ('stash:set-current', (e, data = {}) => {
    if (data.list && Array.isArray (data.list)) frontStashList = data.list;
    if (data.id != null) {
      const label = data.label || '';
      const changed = !frontStash || frontStash.id !== data.id;
      frontStash = { id: String (data.id), label };
      if (changed) {
        stashJustChanged = true;
        pushBallStatus ();
      }
    }
    return { success: true };
  });
  ipcMain.handle ('stash:get-state', () => ({ current: frontStash, list: frontStashList }));
  ipcMain.handle ('stash:switch-in-game', async (e, data = {}) => {
    if (data.stash_id == null) return { success: false, switched: false, reason: 'invalid_stash_id' };
    return await switchInGameStash (String (data.stash_id), data.character_id ? String (data.character_id) : '');
  });
  ipcMain.handle ('stash:tab-test', (e, characterId = '') => backend.tabTest (characterId));
  ipcMain.handle ('stash:tab-scan', () => backend.tabScan ());
  ipcMain.handle ('stash:first-calibrate', async () => {
    calibrateRunning = true;
    pushBallStatus ();
    let r = null;
    try { r = await backend.firstCalibrate (); } catch (e) { r = { error: e?.message || '' }; }
    calibrateRunning = false;
    calibrateJustFinished = true;
    calibrateOk = !!r?.success;
    pushBallStatus ();
    return r;
  });
  ipcMain.handle ('stash:follow-calibrate-status', () => backend.followCalibrateStatus ());
  ipcMain.handle ('stash:follow-calibrate-record', (e, index) => backend.followCalibrateRecord (Number (index)));
  ipcMain.handle ('stash:follow-calibrate-auto', () => backend.followCalibrateAuto ());
  ipcMain.handle ('stash:follow-calibrate-save', () => backend.followCalibrateSave ());
  ipcMain.handle ('stash:follow-calibrate-reset', () => backend.followCalibrateReset ());
  ipcMain.handle ('stash:calibration-status', () => backend.calibrationStatus ());
  ipcMain.handle ('stash:calibration-record', (e, index) => backend.calibrationRecord (Number (index)));
  ipcMain.handle ('stash:calibration-save', (e, resolution = '') => backend.calibrationSave (resolution));
  ipcMain.handle ('stash:calibration-reset', () => backend.calibrationReset ());

  registerStashHotkeys ();
  registerCrossHotkeys ();

  // ── 查价记录 IPC ──

  ipcMain.handle ('history:list', () => {
    loadHistory ();
    pruneHistory ();
    return { records: [...priceHistory].reverse ().map ((r) => ({ ...r, icon: historyIconPath (r) })) };
  });
  ipcMain.handle ('history:clear', () => {
    priceHistory = [];
    historyKeyIndex = new Map ();
    historyDirty = false;
    if (historySaveTimer) { clearTimeout (historySaveTimer); historySaveTimer = null; }
    saveHistory ();
    notifyHome ('history:updated', {});
    return { success: true };
  });

  // ── DnD Tools IPC handlers ──

  ipcMain.handle ('dnd:capture-start', () => backend.captureStart ());
  ipcMain.handle ('dnd:capture-stop', () => backend.captureStop ());
  ipcMain.handle ('dnd:capture-restart', () => backend.captureRestart ());
  ipcMain.handle ('dnd:capture-status', () => backend.captureStatus ());
  ipcMain.handle ('dnd:capture-interfaces', () => backend.captureInterfaces ());
  ipcMain.handle ('dnd:capture-diagnose', () => backend.captureDiagnose ());
  ipcMain.handle ('dnd:npcap-status', (e, force) => backend.npcapStatus (force));
  ipcMain.handle ('dnd:capture-settings', (e, data) => backend.captureUpdateSettings (data));
  ipcMain.handle ('dnd:pick-tshark', async () => {
    const res = await dialog.showOpenDialog ({
      title: '选择 tshark.exe（或 Wireshark.exe / Wireshark 安装目录）',
      buttonLabel: '选择',
      filters: [{ name: 'Wireshark / TShark', extensions: ['exe'] }],
      properties: ['openFile', 'openDirectory', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, path: '' };
    return { canceled: false, path: res.filePaths[0] };
  });

  ipcMain.handle ('dnd:characters', () => backend.getCharacters ());
  ipcMain.handle ('dnd:character', (e, id) => backend.getCharacter (id));
  ipcMain.handle ('dnd:service-port', () => backend.getServicePort ());
  ipcMain.handle ('dnd:clear-characters', () => backend.clearCharacters ());
  ipcMain.handle ('dnd:stash-locks-get', () => backend.getStashLocks ());
  ipcMain.handle ('dnd:stash-locks-set', (e, stashId, locked) => backend.setStashLock (stashId, locked));

  ipcMain.handle ('dnd:sort-start', async (e, params) => {
    const r = await backend.sortStart (params);
    // Minimize the app so it can't cover the game during sorting.
    if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
    return r;
  });
  ipcMain.handle ('dnd:sort-all-start', async (e, params) => {
    const r = await backend.sortAllStart (params);
    if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
    return r;
  });
  ipcMain.handle ('dnd:merge-stacks-start', async (e, params) => {
    const r = await backend.mergeStacksStart (params);
    if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
    return r;
  });
  ipcMain.handle ('dnd:cross-sort-start', async (e, params) => {
    try {
      const r = await backend.crossSortStart (params);
      if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
      return r;
    } catch (err) {
      logger.error (`cross-sort-start handler error: ${err?.message}`, err);
      return { success: false, error: 'handler_error: ' + (err?.message || String (err)) };
    }
  });
  ipcMain.handle ('dnd:precise-sort-start', async (e, params) => {
    try {
      const r = await backend.preciseSortStart (params);
      if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
      return r;
    } catch (err) {
      logger.error (`precise-sort-start handler error: ${err?.message}`, err);
      return { success: false, error: 'handler_error: ' + (err?.message || String (err)) };
    }
  });
  ipcMain.handle ('dnd:sort-cancel', () => backend.sortCancel ());
  ipcMain.handle ('dnd:sort-status', () => backend.sortStatus ());
  ipcMain.handle ('dnd:sort-uipi', () => backend.getSortUipiStatus ());
  ipcMain.handle ('dnd:sort-speed-get', () => backend.getSortSpeed ());
  ipcMain.handle ('dnd:sort-speed-set', (e, value) => backend.setSortSpeed (value));
  ipcMain.handle ('dnd:sort-order-get', () => backend.getSortOrder ());
  ipcMain.handle ('dnd:sort-order-set', (e, order) => backend.updateSortOrder (order));
  ipcMain.handle ('dnd:sort-group-get', () => backend.getSortGroupMode ());
  ipcMain.handle ('dnd:sort-group-set', (e, mode) => backend.setSortGroupMode (mode));
  ipcMain.handle ('dnd:quickplace-get', () => backend.getQuickPlace ());
  ipcMain.handle ('dnd:quickplace-set', (e, enabled) => backend.setQuickPlace (enabled));
  ipcMain.handle ('dnd:narrow-anchor-get', () => backend.getNarrowAnchor ());
  ipcMain.handle ('dnd:narrow-anchor-set', (e, anchor) => backend.setNarrowAnchor (anchor));
  ipcMain.handle ('dnd:sort-preview', (e, params) => backend.sortPreview (params));
  ipcMain.handle ('dnd:sort-config-get', () => ({
    character_id: settings.dnd?.sort_char_id || '',
    stash_id: settings.dnd?.sort_stash_id || '',
    stack_mode: !!settings.dnd?.stack_mode,
    include_inventory: !!settings.dnd?.sort_include_inv,
    keep_in_place: settings.dnd?.keep_in_place !== false,
  }));
  ipcMain.handle ('dnd:sort-config-save', (e, data = {}) => {
    const dnd = settings.dnd || {};
    if (data.character_id !== undefined) dnd.sort_char_id = String (data.character_id || '');
    if (data.stash_id !== undefined) dnd.sort_stash_id = String (data.stash_id || '');
    if (data.stack_mode !== undefined) dnd.stack_mode = !!data.stack_mode;
    if (data.include_inventory !== undefined) dnd.sort_include_inv = !!data.include_inventory;
    if (data.keep_in_place !== undefined) dnd.keep_in_place = !!data.keep_in_place;
    settings.dnd = dnd;
    saveSettings ();
    return { success: true };
  });

  ipcMain.handle ('dnd:packets', (e, page, pageSize) => backend.getPackets (page, pageSize));
  ipcMain.handle ('dnd:packet-detail', (e, id) => backend.getPacketDetail (id));
  ipcMain.handle ('dnd:packets-clear', () => backend.clearPackets ());

  ipcMain.handle ('settings:get', () => ({
    api_key: settings.general.api_key || '',
    scan_key: settings.hotkeys.run_price_check || 'XButton1',
    default_mode: settings.general.default_mode || 'manual',
    alignment: settings.general.alignment || 'attached',
    scale: settings.general.scale || 1.0,
    components: settings.general.components || [],
    live_price_mode: settings.general.live_price_mode || 'presence',
    live_price_relax: settings.general.live_price_relax || 'none',
    scan_cache_days: settings.general.scan_cache_days ?? 1,
    history_days: settings.general.history_days ?? 3,
    requery_debounce: settings.general.requery_debounce ?? 600,
    launch_on_startup: !!settings.general.launch_on_startup,
    sort_hotkey: settings.dnd?.sort_hotkey || 'Ctrl+R',
    cancel_hotkey: settings.dnd?.cancel_hotkey || 'Ctrl+T',
    stash_next_key: settings.dnd?.stash_next_key || 'Ctrl+E',
    follow_mode: ['off', 'click', 'pixel'].includes (settings.dnd?.follow_mode) ? settings.dnd.follow_mode : 'click',
    cross_config: (() => {
      try { return JSON.parse (settings.dnd?.cross_config || 'null') || null; } catch (e) { return null; }
    })(),
    developer_mode: !!settings.general.developer_mode,
    theme: settings.general.theme === 'dark' ? 'dark' : 'light',
    font_scale: parseFloat (settings.general.font_scale) || 1.0,
    app_version: app.getVersion (),
    disclaimer_agreed_version: settings.general.disclaimer_agreed_version || '',
    auto_check_update: settings.general.auto_check_update !== false,
  }));

  ipcMain.handle ('settings:save', (e, data) => {
    let needReregister = false;
    let needSend = false;
    let needSortReregister = false;

    if (data.api_key !== undefined) settings.general.api_key = data.api_key;
    if (data.scan_key !== undefined && data.scan_key !== settings.hotkeys.run_price_check) {
      settings.hotkeys.run_price_check = data.scan_key;
      needReregister = true;
    }
    if (data.sort_hotkey !== undefined && data.sort_hotkey !== settings.dnd.sort_hotkey) {
      settings.dnd.sort_hotkey = data.sort_hotkey;
      needSortReregister = true;
    }
    if (data.cancel_hotkey !== undefined && data.cancel_hotkey !== settings.dnd.cancel_hotkey) {
      settings.dnd.cancel_hotkey = data.cancel_hotkey;
      needSortReregister = true;
    }
    let needStashReregister = false;
    if (data.stash_next_key !== undefined && data.stash_next_key !== settings.dnd.stash_next_key) {
      settings.dnd.stash_next_key = data.stash_next_key;
      needStashReregister = true;
    }
    let needCrossReregister = false;
    if (data.cross_hotkey !== undefined && data.cross_hotkey !== settings.dnd.cross_hotkey) {
      settings.dnd.cross_hotkey = data.cross_hotkey;
      needCrossReregister = true;
    }
    if (data.follow_mode !== undefined && ['off', 'click', 'pixel'].includes (data.follow_mode)) {
      settings.dnd.follow_mode = data.follow_mode;
    }
    if (data.cross_config !== undefined) {
      settings.dnd.cross_config = typeof data.cross_config === 'string' ? data.cross_config : JSON.stringify (data.cross_config || {});
    }
    if (data.developer_mode !== undefined) {
      settings.general.developer_mode = !!data.developer_mode;
    }
    if (data.theme !== undefined && (data.theme === 'dark' || data.theme === 'light')) {
      settings.general.theme = data.theme;
      if (homeWindow && !homeWindow.isDestroyed ()) {
        homeWindow.setBackgroundColor (data.theme === 'dark' ? '#1c1c1f' : '#f4f4f6');
      }
    }
    if (data.font_scale !== undefined) {
      settings.general.font_scale = Math.min (1.4, Math.max (0.8, parseFloat (data.font_scale) || 1.0));
    }
    if (data.disclaimer_agreed_version !== undefined) {
      settings.general.disclaimer_agreed_version = String (data.disclaimer_agreed_version || '');
    }
    if (data.auto_check_update !== undefined) {
      settings.general.auto_check_update = !!data.auto_check_update;
    }
    if (data.default_mode !== undefined) { settings.general.default_mode = data.default_mode; needSend = true; }
    if (data.alignment !== undefined) { settings.general.alignment = data.alignment; needSend = true; }
    if (data.scale !== undefined) { settings.general.scale = parseFloat (data.scale); needSend = true; }
    if (data.components !== undefined) { settings.general.components = toComponents (data.components); needSend = true; }
    if (data.live_price_mode !== undefined && [ 'presence', 'value' ].includes (data.live_price_mode)) settings.general.live_price_mode = data.live_price_mode;
    if (data.live_price_relax !== undefined && [ 'none', 'all', 'sa', 'b' ].includes (data.live_price_relax)) settings.general.live_price_relax = data.live_price_relax;
    if (data.scan_cache_days !== undefined) settings.general.scan_cache_days = toDays (data.scan_cache_days, settings.general.scan_cache_days);
    if (data.history_days !== undefined) settings.general.history_days = toDays (data.history_days, settings.general.history_days);
    if (data.requery_debounce !== undefined) settings.general.requery_debounce = toDebounce (data.requery_debounce);
    if (data.launch_on_startup !== undefined) {
      settings.general.launch_on_startup = !!data.launch_on_startup;
      app.setLoginItemSettings ({
        openAtLogin: settings.general.launch_on_startup,
        path: process.execPath,
        args: ['--processStart', `${basename (process.execPath)}`, '--process-start-args', '--hidden']
      });
    }

    saveSettings ();
    if (needSend) overlay.webContents.send ('settings', settings);
    if (needReregister) registerScanHotkey (overlay);
    if (needSortReregister) registerSortHotkeys ();
    if (needStashReregister) registerStashHotkeys ();
    if (needCrossReregister) registerCrossHotkeys ();
    pushBallStatus ();
    return { success: true };
  });

  ipcMain.handle ('app:quit', () => {
    app.quit ();
    return { success: true };
  });

  ipcMain.handle ('update:check', () => checkForUpdate ());

  openHomeWindow ();
  createBallWindow ();
  scheduleDailyUpdateCheck ();
});

const UPDATE_API = 'https://api.github.com/repos/FR-HL/DarkTavern/releases/latest';

function compareVersions (a, b) {
  const pa = String (a).split ('.').map (n => parseInt (n) || 0);
  const pb = String (b).split ('.').map (n => parseInt (n) || 0);
  for (let i = 0; i < Math.max (pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function checkForUpdate () {
  try {
    const res = await fetch (UPDATE_API, {
      headers: { 'User-Agent': 'AdventurersSquire', 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const data = await res.json ();
    const latest = String (data.tag_name || '').replace (/^v/i, '');
    const current = app.getVersion ();
    if (!latest) return { success: false, error: '无版本信息' };
    return {
      success: true,
      has_update: compareVersions (latest, current) > 0,
      latest,
      current,
      url: data.html_url || 'https://github.com/FR-HL/DarkTavern/releases',
    };
  } catch (e) {
    return { success: false, error: e?.message || String (e) };
  }
}

function todayStr () {
  const d = new Date ();
  return `${d.getFullYear ()}-${String (d.getMonth () + 1).padStart (2, '0')}-${String (d.getDate ()).padStart (2, '0')}`;
}

function scheduleDailyUpdateCheck () {
  if (settings.general.auto_check_update === false) return;
  const today = todayStr ();
  if (settings.general.last_update_check === today) return;
  settings.general.last_update_check = today;
  saveSettings ();
  setTimeout (async () => {
    const r = await checkForUpdate ();
    if (r.success && r.has_update && homeWindow && !homeWindow.isDestroyed ()) {
      homeWindow.webContents.send ('update:available', r);
    }
  }, 8000);
}

async function registerScanHotkey (overlay) {
  let key = settings.hotkeys.run_price_check;
  if (RESERVED_KEYS.includes (key) || /^(Mouse(Left|Right))$/.test (key)) {
    key = 'XButton1';
    settings.hotkeys.run_price_check = 'XButton1';
    saveSettings ();
  }

  const mouseMap = {
    'XButton1': 'mousebutton4', 'XButton2': 'mousebutton5',
    'MouseMiddle': 'mousebutton1',
    'MouseButton4': 'mousebutton4', 'MouseButton5': 'mousebutton5',
  };

  let accelerator = mouseMap[key] || key;
  let isMouse = accelerator.startsWith ('mousebutton');

  if (previousScanAccelerator && !previousScanAccelerator.startsWith ('mousebutton') && !RESERVED_KEYS.includes (previousScanAccelerator)) {
    try { globalShortcut.unregister (previousScanAccelerator); } catch (e) {}
  }
  if (global._mousePollInterval) { clearInterval (global._mousePollInterval); global._mousePollInterval = null; }

  if (isMouse) {
    const vkMap = { 'mousebutton1': 0x04, 'mousebutton4': 0x05, 'mousebutton5': 0x06 };
    const vkCode = vkMap[accelerator] || 0x05;

    try {
      const { createRequire } = await import ('node:module');
      const _require = createRequire (import.meta.url);
      const koffi = _require ('koffi');
      const user32 = koffi.load ('user32.dll');
      const GetAsyncKeyState = user32.func ('short __stdcall GetAsyncKeyState(int vKey)');

      let wasPressed = false;
      global._mousePollInterval = setInterval (() => {
        const pressed = (GetAsyncKeyState (vkCode) & 0x8000) !== 0;
        if (pressed && !wasPressed) overlay.webContents.send ('manual:scan');
        wasPressed = pressed;
      }, 100);
      logger.info (`Scan mouse button: VK=0x${vkCode.toString (16)}`);
    } catch (e) {
      logger.error (`Mouse polling failed: ${e.message}`);
    }
  } else {
    try {
      globalShortcut.register (accelerator, () => overlay.webContents.send ('manual:scan'));
      logger.info (`Scan key: ${key}`);
    } catch (e) {
      logger.error (`Failed to register ${key}: ${e.message}`);
    }
  }

  previousScanAccelerator = accelerator;
}

function notifyHome (event, data) {
  if (homeWindow && !homeWindow.isDestroyed ()) homeWindow.webContents.send (event, data);
}

// ── 前端仓库页切换快捷键 ──

let registeredStashKeys = null;

// 联动游戏内切换：点击游戏内对应仓库标签（尽力而为）。
// 游戏未开 / 标签映射未配置 / 背包装备页等场景直接跳过，仅提示。
async function switchInGameStash (stashId, characterId = '') {
  try {
    const r = await backend.switchStash (stashId, characterId);
    if (r && r.switched === true) {
      logger.info (`In-game stash switched to ${stashId}`);
      return r;
    }
    const reason = r?.reason || 'unknown';
    const messages = {
      game_not_found: '未检测到游戏窗口，仅切换前端显示',
      mapping_not_configured: '仓库标签映射未配置，仅切换前端显示',
      uipi_blocked: '游戏以管理员权限运行，鼠标模拟被拦截，仅切换前端显示',
      click_failed: '游戏内仓库标签切换失败，仅切换前端显示',
    };
    const msg = messages[reason];
    if (msg) {
      notifyHome ('stash:notify', { type: 'info', message: msg });
    } else if (reason !== 'no_tab') {
      logger.warn (`In-game stash switch skipped (${reason}) for stash ${stashId}`);
    }
    return r || { success: false, switched: false, reason: 'service_unavailable' };
  } catch (e) {
    logger.error (`In-game stash switch failed: ${e.message}`);
    return { success: false, switched: false, reason: 'error' };
  }
}

function switchFrontStash (targetId, label) {
  if (targetId == null) {
    notifyHome ('stash:notify', { type: 'error', message: '没有可切换的仓库（请先在角色仓库页加载角色）' });
    return;
  }
  // 异步联动游戏内标签，不阻塞前端切换
  switchInGameStash (String (targetId));
  notifyHome ('stash:switch-to', { stash_id: String (targetId), label: label || '' });
  // 回传状态（不依赖仓库页是否打开）：主进程直接更新 frontStash 并推送悬浮球
  const changed = !frontStash || frontStash.id !== String (targetId);
  frontStash = { id: String (targetId), label: label || '' };
  if (changed) {
    stashJustChanged = true;
    pushBallStatus ();
  }
}

function registerStashHotkeys () {
  const nextKey = settings.dnd?.stash_next_key || 'Ctrl+E';

  if (registeredStashKeys) {
    for (const k of registeredStashKeys) {
      try { globalShortcut.unregister (k); } catch (e) {}
    }
    registeredStashKeys = null;
  }
  const registered = [];

  // 循环切换：列表中当前页 → 下一个（跳过背包/装备，它们无游戏内标签）
  try {
    globalShortcut.register (nextKey, () => {
      const list = frontStashList.filter (s => !['2', '3'].includes (String (s.id)));
      if (!list.length) { switchFrontStash (null); return; }
      const cur = frontStash?.id != null ? String (frontStash.id) : null;
      const idx = cur ? list.findIndex (s => String (s.id) === cur) : -1;
      const next = list[(idx + 1) % list.length];
      switchFrontStash (next.id, next.label);
    });
    registered.push (nextKey);
    logger.info (`Stash next hotkey: ${nextKey}`);
  } catch (e) {
    logger.error (`Failed to register stash hotkey ${nextKey}: ${e.message}`);
  }

  registeredStashKeys = registered;
}

let registeredCrossKeys = null;

function registerCrossHotkeys () {
  const crossKey = settings.dnd?.cross_hotkey || 'Ctrl+F12';

  if (registeredCrossKeys) {
    for (const k of registeredCrossKeys) {
      try { globalShortcut.unregister (k); } catch (e) {}
    }
    registeredCrossKeys = null;
  }
  const registered = [];

  // 开始跨仓整理：使用保存的配置与角色
  try {
    globalShortcut.register (crossKey, async () => {
      const charId = settings.dnd?.sort_char_id || '';
      if (!charId) {
        notifyHome ('dnd:sort-notify', { type: 'error', message: '未配置整理角色，请先在角色仓库页选择角色' });
        return;
      }
      let config = {};
      try { config = JSON.parse (settings.dnd?.cross_config || '{}') || {}; } catch (e) {}
      config.merge = !!settings.dnd?.stack_mode;
      config.clear_bag = !!settings.dnd?.sort_include_inv;
      const r = await backend.crossSortStart ({ character_id: charId, config });
      if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
    });
    registered.push (crossKey);
    logger.info (`Cross-sort hotkey: ${crossKey}`);
  } catch (e) {
    logger.error (`Failed to register cross-sort hotkey ${crossKey}: ${e.message}`);
  }

  registeredCrossKeys = registered;
}

let registeredSortKeys = null;

function registerSortHotkeys () {
  const sortKey = settings.dnd?.sort_hotkey || 'Ctrl+R';
  const cancelKey = settings.dnd?.cancel_hotkey || 'Ctrl+T';

  if (registeredSortKeys) {
    for (const k of registeredSortKeys) {
      try { globalShortcut.unregister (k); } catch (e) {}
    }
    registeredSortKeys = null;
  }

  try {
    globalShortcut.register (sortKey, async () => {
      const charId = settings.dnd?.sort_char_id || '';
      const stashId = settings.dnd?.sort_stash_id || '';
      if (!charId || !stashId) {
        logger.warn ('Sort hotkey pressed but no target configured');
        notifyHome ('dnd:sort-notify', { type: 'error', message: '未配置整理目标，请先在整理页选择角色与仓库' });
        return;
      }
      try {
        const r = await backend.sortStart ({
          character_id: charId,
          stash_id: stashId,
          stack_mode: !!settings.dnd?.stack_mode,
          include_inventory: !!settings.dnd?.sort_include_inv,
          keep_in_place: settings.dnd?.keep_in_place !== false,
        });
        logger.info (`Sort hotkey: char=${charId} stash=${stashId} -> ${r?.success ? 'started' : (r?.error || 'failed')}`);
        notifyHome ('dnd:sort-notify', r?.success
          ? { type: 'info', message: `开始整理仓库 ${stashId}` }
          : { type: 'error', message: r?.error || '整理启动失败' });
        if (r?.success) {
          if (homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
          notifyHome ('dnd:sort-started', { character_id: charId, stash_id: stashId });
        }
      } catch (e) {
        logger.error (`Sort hotkey handler failed: ${e.message}`);
        notifyHome ('dnd:sort-notify', { type: 'error', message: `整理启动失败: ${e.message}` });
      }
    });
    logger.info (`Sort hotkey: ${sortKey}`);
  } catch (e) {
    logger.error (`Failed to register sort hotkey ${sortKey}: ${e.message}`);
  }

  try {
    globalShortcut.register (cancelKey, async () => {
      await backend.sortCancel ();
      notifyHome ('dnd:sort-cancelled', {});
    });
    logger.info (`Sort cancel hotkey: ${cancelKey}`);
  } catch (e) {
    logger.error (`Failed to register cancel hotkey ${cancelKey}: ${e.message}`);
  }

  registeredSortKeys = [sortKey, cancelKey];
}

function openSettingsWindow (tab) {
  const paneMap = { settings: 'settings', mapping: 'config' };
  const pane = paneMap[tab] || 'settings';

  if (!homeWindow) { pendingPane = pane; openHomeWindow (); return; }
  if (homeWindow.isMinimized ()) homeWindow.restore ();
  homeWindow.show ();
  homeWindow.focus ();
  if (tab === 'mapping') homeWindow.webContents.send ('navigate', { pane: 'config', devCard: 'mapping' });
  else homeWindow.webContents.send ('navigate', pane);
}

function openHomeWindow () {
  if (homeWindow) {
    // 窗口已销毁但引用未清（closed 事件竞态）→ 重置后重建，避免 isMinimized 抛异常
    if (homeWindow.isDestroyed ()) { homeWindow = null; }
    else {
      if (homeWindow.isMinimized ()) homeWindow.restore ();
      homeWindow.show ();
      homeWindow.focus ();
      return;
    }
  }

  homeWindow = new BrowserWindow ({
    width: 1280, height: 840, minWidth: 1080, minHeight: 720,
    show: false, title: '冒险者侍从', autoHideMenuBar: true,
    icon: join (ROOT, 'assets/images/icon.ico'),
    backgroundColor: settings.general.theme === 'dark' ? '#1c1c1f' : '#f4f4f6',
    webPreferences: { sandbox: false, preload: join (SOURCE, 'preload.cjs') },
  });

  homeWindow.webContents.on ('did-finish-load', () => {
    if (pendingPane) { homeWindow.webContents.send ('navigate', pendingPane); pendingPane = null; }
    homeWindow.webContents.send ('game:status', { found: getCanScan () });
    homeWindow.webContents.send ('ocr:status', { ok: ocrStatus });
  });

  homeWindow.loadFile (join (ROOT, 'dist', 'home', 'index.html'));
  homeWindow.once ('ready-to-show', () => { homeWindow.show (); homeWindow.focus (); });
  homeWindow.on ('closed', () => { homeWindow = null; });
}

// ── 悬浮球 ──

// ── 悬浮球拖拽：系统级光标读取（koffi，避免 Electron 光标缓存导致快速移动不跟手） ──

let ballCursor = null;

function initBallCursor () {
  if (ballCursor) return ballCursor;
  try {
    const koffi = _require ('koffi');
    const user32 = koffi.load ('user32.dll');
    const POINT = koffi.struct ('POINT', { x: 'long', y: 'long' });
    const getPos = user32.func ('bool GetCursorPos(_Out_ POINT *lpPoint)');
    const getKey = user32.func ('short __stdcall GetAsyncKeyState(int vKey)');
    ballCursor = {
      pos: () => {
        const p = {};
        if (getPos (p)) return { x: p.x, y: p.y };
        return null;
      },
      leftDown: () => (getKey (0x01) & 0x8000) !== 0,
    };
  } catch (e) {
    ballCursor = false;
  }
  return ballCursor;
}

function defaultBallPos () {
  const wa = screen.getPrimaryDisplay ().workArea;
  return {
    x: wa.x + wa.width - BALL_SIZE.w - 24,
    y: wa.y + Math.round ((wa.height - BALL_SIZE.h) / 2),
  };
}

function ballPosFromSettings () {
  const x = settings.general.ball_x;
  const y = settings.general.ball_y;
  if (x == null || y == null) return defaultBallPos ();

  const wa = screen.getDisplayMatching ({ x, y, width: 20, height: 20 }).workArea;
  return {
    x: Math.min (Math.max (x, wa.x), wa.x + wa.width - BALL_SIZE.w),
    y: Math.min (Math.max (y, wa.y), wa.y + wa.height - BALL_SIZE.h),
  };
}

function saveBallPos () {
  if (!ballWindow) return;
  const now = Date.now ();
  if (now - lastBallSave < 500) return;
  lastBallSave = now;
  const [x, y] = ballWindow.getPosition ();
  settings.general.ball_x = x;
  settings.general.ball_y = y;
  saveSettings ();
}

function createBallWindow () {
  if (ballWindow) return;

  const pos = ballPosFromSettings ();

  ballWindow = new BrowserWindow ({
    width: BALL_SIZE.w,
    height: BALL_SIZE.h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join (SOURCE, 'preload.cjs'),
      sandbox: false,
      backgroundThrottling: true,
    },
  });

  ballWindow.setAlwaysOnTop (true, 'screen-saver');
  ballWindow.setVisibleOnAllWorkspaces (true);
  ballWindow.loadFile (join (ROOT, 'dist', 'ball', 'index.html'));

  ballWindow.once ('ready-to-show', () => {
    if (ballVisible) ballWindow.show ();
    applyBallLock ();
  });
  ballWindow.on ('move', saveBallPos);
  ballWindow.on ('closed', () => {
    ballWindow = null;
    if (ballStatusTimer) { clearInterval (ballStatusTimer); ballStatusTimer = null; }
    if (ballDragTimer) { clearInterval (ballDragTimer); ballDragTimer = null; }
    ballDrag = null;
  });

  ballStatusTimer = setInterval (pushBallStatus, 5000);
}

function applyBallLock () {
  if (!ballWindow) return;
  ballWindow.setIgnoreMouseEvents (ballLocked, { forward: true });
}

function setBallLocked (locked) {
  if (ballLocked === locked) return;
  ballLocked = locked;
  settings.general.ball_locked = locked;
  saveSettings ();
  applyBallLock ();
  pushBallStatus ();
  refreshTrayMenu ();
}

function toggleBallVisible () {
  ballVisible = !ballVisible;
  settings.general.ball_visible = ballVisible;
  saveSettings ();
  if (ballWindow && !ballWindow.isDestroyed ()) {
    if (ballVisible) {
      ballWindow.show ();
      applyBallLock ();
    } else {
      ballWindow.hide ();
    }
  }
  pushBallStatus ();
  refreshTrayMenu ();
}

function popupBallMenu () {
  if (!ballWindow) return;

  Menu.buildFromTemplate ([
    { label: ballLocked ? '解锁悬浮球' : '锁定悬浮球', click: () => setBallLocked (!ballLocked) },
    { type: 'separator' },
    { label: '打开主页', click: () => openHomeWindow () },
    { label: '查价器设置', click: () => openSettingsWindow ('settings') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit () },
  ]).popup ({ window: ballWindow });
}

async function gatherBallStatus () {
  // 4 个服务查询并行（旧方案串行等待，服务忙时每轮累计延迟）
  const [healthR, captureR, sortingR, currentR] = await Promise.allSettled ([
    backend.healthRaw (),
    backend.captureStatus (),
    backend.sortStatus (),
    backend.getCurrentCharacter (),
  ]);
  const health = healthR.status === 'fulfilled' ? healthR.value : null;
  const capture = captureR.status === 'fulfilled' && captureR.value ? captureR.value : { running: false };
  const sorting = sortingR.status === 'fulfilled' && sortingR.value ? sortingR.value : { running: false };
  let current = null;
  try {
    const d = currentR.status === 'fulfilled' ? currentR.value : null;
    current = d?.current || null;
  } catch (e) {}

  // 角色/仓库数据更新检测（id 或更新时间变化 → 一次性瞬态标记）
  const charKey = current ? `${current.id}|${current.updated_at || ''}` : '';
  const charJustUpdated = !!charKey && charKey !== lastCharKey;
  if (charKey) lastCharKey = charKey;
  else lastCharKey = '';

  // 整理结束检测（running true → false 且带结果）
  const sortJustFinished = lastSortRunning && !sorting.running && (!!sorting.result || !!sorting.error);
  lastSortRunning = !!sorting.running;

  // 前端仓库页变化标记（一次性，推送后清除）
  const stashChanged = stashJustChanged;
  stashJustChanged = false;

  // 首次校准完成标记（一次性，推送后清除）
  const calibrateDone = calibrateJustFinished;
  calibrateJustFinished = false;

  let lastSortText = '';
  if (sorting.result) {
    lastSortText = sorting.result.success ? '成功 ✓' : ('失败：' + (sorting.result.message || ''));
  } else if (sorting.error) {
    lastSortText = '失败：' + String (sorting.error);
  }

  return {
    locked: ballLocked,
    ballVisible,
    sessionScans: sessionScanCount,
    ocr: !!(health && health.status === 'ok'),
    version: health?.version || '—',
    mappings: health?.mappings || 0,
    game: getCanScan (),
    scanKey: settings.hotkeys.run_price_check || 'XButton1',
    apiKey: !!settings.general.api_key,
    captureRunning: !!capture.running,
    sortingRunning: !!sorting.running,
    scanning: ballScanning,
    sortJustFinished,
    sortOk: !!sorting.result?.success,
    lastSortText,
    frontStash,
    stashJustChanged: stashChanged,
    calibrateRunning,
    calibrateJustFinished: calibrateDone,
    calibrateOk,
    character: current ? {
      nickname: current.nickname,
      cls: current.class,
      level: current.level,
      stashCount: current.stash_count,
      totalItems: current.total_items,
      updatedAt: current.updated_at,
    } : null,
    charJustUpdated,
    lastScan: { ...lastScan },
  };
}

function sendBallScanResult () {
  if (!ballWindow || ballWindow.isDestroyed ()) return;
  ballWindow.webContents.send ('ball:scan-result', { ...lastScan });
}

// ── 物品中文名（assets/items.json，惰性加载缓存） ──

let itemsDb = null;

function loadItemsDb () {
  if (itemsDb) return itemsDb;
  try {
    itemsDb = JSON.parse (readFileSync (join (ROOT, 'assets', 'items.json'), 'utf-8'));
  } catch (e) {
    logger.error (`Failed to load items.json: ${e.message}`);
    itemsDb = {};
  }
  return itemsDb;
}

function findZhName (rawId) {
  if (!rawId) return '';
  const db = loadItemsDb ();
  const direct = db[rawId];
  if (direct && direct.name_zh) return direct.name_zh;
  for (const key of Object.keys (db)) {
    const it = db[key];
    if ((it.origin_id && it.origin_id === rawId) || (it.archetype && it.archetype === rawId)) {
      if (it.name_zh) return it.name_zh;
    }
  }
  return '';
}

// ── 查价记录（保存 3 天内查过的物品） ──

let priceHistory = null;
let historyKeyIndex = null;   // key → 最新记录（findScanCache 用，避免每次扫描全量遍历）
let historySaveTimer = null;  // 写盘节流：5 秒内合并多次扫描为一次写入
let historyDirty = false;

function historyTtl () {
  return (settings.general.history_days ?? 3) * 24 * 3600 * 1000;
}

function scanCacheTtl () {
  return (settings.general.scan_cache_days ?? 1) * 24 * 3600 * 1000;
}

function rebuildHistoryKeyIndex () {
  historyKeyIndex = new Map ();
  for (const r of priceHistory) {
    if (!r.key) continue;
    const cur = historyKeyIndex.get (r.key);
    if (!cur || r.ts > cur.ts) historyKeyIndex.set (r.key, r);
  }
}

function pruneHistory () {
  const cutoff = Date.now () - historyTtl ();
  const before = priceHistory.length;
  priceHistory = priceHistory.filter ((r) => r.ts >= cutoff);
  if (priceHistory.length !== before) rebuildHistoryKeyIndex ();
}

function findScanCache (key) {
  if (!key) return null;
  const ttl = scanCacheTtl ();
  if (ttl <= 0) return null;
  if (!historyKeyIndex) loadHistory ();
  const r = historyKeyIndex.get (key);
  if (r && r.ts >= Date.now () - ttl) return r;
  return null;
}

let itemIconIndex = null;

function buildItemIconIndex () {
  const idx = { byKey: {}, byNameRarity: {}, byName: {} };
  try {
    const d = JSON.parse (readFileSync (join (ROOT, 'assets', 'items.json'), 'utf-8'));
    for (const [k, v] of Object.entries (d)) {
      const p = v?.iconPath || null;
      if (!p) continue;
      idx.byKey[k.toLowerCase ()] = p;
      const n = String (v.name || '').toLowerCase ();
      if (!n) continue;
      if (!idx.byName[n]) idx.byName[n] = p;
      if (v.rarity) idx.byNameRarity[`${n}|${String (v.rarity).toLowerCase ()}`] = p;
    }
  } catch (e) {
    logger.error (`Failed to load items.json: ${e.message}`);
  }
  return idx;
}

function historyIconPath (rec) {
  if (!itemIconIndex) itemIconIndex = buildItemIconIndex ();
  const id = String (rec.id || '').replace (/^id\.item\./, '').toLowerCase ();
  if (id && itemIconIndex.byKey[id]) return itemIconIndex.byKey[id];
  const name = String (rec.name || '').toLowerCase ();
  if (!name) return null;
  const rarity = String (rec.rarity || '').toLowerCase ();
  return itemIconIndex.byNameRarity[`${name}|${rarity}`] || itemIconIndex.byName[name] || null;
}

function historyPath () {
  return join (dataDir (app), 'price_history.json');
}

function loadHistory () {
  if (priceHistory) return priceHistory;
  try {
    const d = JSON.parse (readFileSync (historyPath (), 'utf-8'));
    priceHistory = Array.isArray (d.records) ? d.records : [];
  } catch (e) {
    priceHistory = [];
  }
  rebuildHistoryKeyIndex ();
  return priceHistory;
}

function saveHistory () {
  try {
    writeFileSync (historyPath (), JSON.stringify ({ records: priceHistory }, null, 2));
  } catch (e) {
    logger.error (`Failed to save price history: ${e.message}`);
  }
}

// 节流写盘：连续扫描合并为每 5 秒最多一次全量写入（旧方案每次扫描都写）
function scheduleSaveHistory () {
  historyDirty = true;
  if (historySaveTimer) return;
  historySaveTimer = setTimeout (() => {
    historySaveTimer = null;
    if (historyDirty) { historyDirty = false; saveHistory (); }
  }, 5000);
}

function upsertHistoryRecord () {
  loadHistory ();
  const rec = {
    ts: lastScan.ts,
    id: lastScan.id,
    name: lastScan.name,
    zhName: lastScan.zhName,
    rarity: lastScan.rarity,
    price: lastScan.price,
    market: lastScan.market,
    vendor: lastScan.pricing?.vendor ?? null,
    density: lastScan.pricing?.density ?? null,
    attributes: lastScan.attributes,
    reverseAttributes: lastScan.reverseAttributes,
    usedAffixes: lastScan.usedAffixes || [],
    key: lastScan.key || '',
  };
  const last = priceHistory[priceHistory.length - 1];
  if (last && last.id === rec.id && last.ts === rec.ts) {
    Object.assign (last, rec);
  } else {
    priceHistory.push (rec);
  }
  if (rec.key) {
    const cur = historyKeyIndex ? historyKeyIndex.get (rec.key) : null;
    if (!cur || rec.ts > cur.ts) historyKeyIndex.set (rec.key, rec);
  }
  pruneHistory ();
  notifyHome ('history:updated', {});
  scheduleSaveHistory ();
}

async function pushBallStatus () {
  if (!ballWindow || ballWindow.isDestroyed ()) return;
  try {
    const status = await gatherBallStatus ();
    const serialized = JSON.stringify (status);
    if (serialized !== lastBallStatus) {
      lastBallStatus = serialized;
      ballWindow.webContents.send ('ball:status', status);
    }
  } catch (e) {
    logger.error (`Ball status push failed: ${e.message}`);
  }
}

async function refreshTrayMenu () {
  if (!tray) return;

  try { ocrStatus = await backend.health (); } catch (e) { ocrStatus = false; }
  const gameOk = getCanScan ();

  if (homeWindow) homeWindow.webContents.send ('ocr:status', { ok: ocrStatus });

  const dot = (ok) => ok ? '●' : '○';

  tray.setContextMenu (Menu.buildFromTemplate ([
    { label: `冒险者侍从 v${app.getVersion ()}`, enabled: false },
    { type: 'separator' },
    { label: `${dot (ocrStatus)} OCR 侍者：${ocrStatus ? '已就绪' : '唤醒中…'}`, enabled: false },
    { label: `${dot (gameOk)} 游戏窗口：${gameOk ? '已检测到' : '未检测到'}`, enabled: false },
    { type: 'separator' },
    { label: '主页', click: () => openHomeWindow () },
    { label: `${ballLocked ? '○' : '●'} 悬浮球：${ballLocked ? '已锁定' : '已解锁'}（点击切换）`, click: () => setBallLocked (!ballLocked) },
    { label: `${ballVisible ? '●' : '○'} 悬浮球：${ballVisible ? '已显示' : '已隐藏'}（点击切换）`, click: () => toggleBallVisible () },
    { type: 'separator' },
    { label: '日志文件夹', click: () => shell.openPath (logPath) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit () }
  ]));

  pushBallStatus ();
}
