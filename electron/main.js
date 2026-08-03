import electron, { globalShortcut, Menu, screen, shell, Tray } from 'electron';
import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { logger, logPath } from './logger.js';
import { ROOT, SOURCE } from './config.js';
import { settings, saveSettings } from './settings.js';
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
let ballScanning = false;
let ballExpanded = false;
let ballStatusTimer = null;
let lastBallStatus = null;
let lastBallSave = 0;
let ballDrag = null;
let ballDragTimer = null;
let lastCharKey = '';
let lastSortRunning = false;
let lastScan = { ok: null, name: '', price: null, market: null, rarity: '', id: '', zhName: '', message: '', ts: 0 };
const BALL_COLLAPSED = { w: 82, h: 82 };
const BALL_EXPANDED = { w: 340, h: 590 };

process.on ('uncaughtException', (e) => logger.error ('Uncaught Exception:', e));
process.on ('unhandledRejection', (r) => logger.error (`Unhandled Rejection: ${r}`));
process.on ('SIGTERM', () => process.exit (0));
process.on ('SIGINT', () => process.exit (0));

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
app.on ('second-instance', () => {});

app.on ('before-quit', () => {
  globalShortcut.unregisterAll ();
  if (healthTimer) { clearInterval (healthTimer); healthTimer = null; }
  if (ballStatusTimer) { clearInterval (ballStatusTimer); ballStatusTimer = null; }
  if (ballDragTimer) { clearInterval (ballDragTimer); ballDragTimer = null; }
  backend.stopService ();
  stopTracking ();
});

app.on ('ready', async () => {
  backend.startService (settings.general.python_path);

  tray = new Tray (join (ROOT, 'assets/images/Icon-81x89.png'));
  tray.setToolTip ('DarkTavern');
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
    focusable: false,
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
      lastScan.ok = !!r.ok;
      if (r.name !== undefined) lastScan.name = r.name;
      if (r.live !== undefined) lastScan.price = r.live;
      if (r.market !== undefined) lastScan.market = r.market;
      if (r.rarity !== undefined) lastScan.rarity = r.rarity;
      if (r.id !== undefined) lastScan.id = r.id;
      if (r.message !== undefined) lastScan.message = r.message;
      lastScan.zhName = findZhName (lastScan.id);
      lastScan.ts = Date.now ();
      sendBallScanResult ();
    }
  });

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
  ipcMain.handle ('ball:resize', (e, data) => setBallExpanded (!!data?.expanded));
  ipcMain.handle ('ball:menu', () => popupBallMenu ());
  ipcMain.handle ('ball:open-home', () => openHomeWindow ());
  ipcMain.handle ('ball:open-settings', () => openSettingsWindow ('settings'));

  ipcMain.handle ('ball:drag-start', () => {
    if (!ballWindow || ballWindow.isDestroyed ()) return;
    const [wx, wy] = ballWindow.getPosition ();
    const c = screen.getCursorScreenPoint ();
    ballDrag = { wx, wy, cx: c.x, cy: c.y, moved: false };
    if (ballDragTimer) clearInterval (ballDragTimer);
    ballDragTimer = setInterval (() => {
      if (!ballDrag || !ballWindow || ballWindow.isDestroyed ()) return;
      const cur = screen.getCursorScreenPoint ();
      const dx = cur.x - ballDrag.cx;
      const dy = cur.y - ballDrag.cy;
      if (!ballDrag.moved && Math.abs (dx) + Math.abs (dy) > 3) ballDrag.moved = true;
      if (ballDrag.moved) ballWindow.setPosition (Math.round (ballDrag.wx + dx), Math.round (ballDrag.wy + dy));
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

  // ── DnD Tools IPC handlers ──

  ipcMain.handle ('dnd:capture-start', () => backend.captureStart ());
  ipcMain.handle ('dnd:capture-stop', () => backend.captureStop ());
  ipcMain.handle ('dnd:capture-restart', () => backend.captureRestart ());
  ipcMain.handle ('dnd:capture-status', () => backend.captureStatus ());
  ipcMain.handle ('dnd:capture-interfaces', () => backend.captureInterfaces ());
  ipcMain.handle ('dnd:capture-diagnose', () => backend.captureDiagnose ());
  ipcMain.handle ('dnd:capture-settings', (e, data) => backend.captureUpdateSettings (data));
  ipcMain.handle ('dnd:pick-tshark', async () => {
    const res = await dialog.showOpenDialog ({
      title: '选择 tshark.exe（或 Wireshark.exe / Wireshark 安装目录）',
      buttonLabel: '选择',
      filters: [{ name: 'Wireshark / TShark', extensions: ['exe'] }],
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, path: '' };
    return { canceled: false, path: res.filePaths[0] };
  });

  ipcMain.handle ('dnd:characters', () => backend.getCharacters ());
  ipcMain.handle ('dnd:character', (e, id) => backend.getCharacter (id));
  ipcMain.handle ('dnd:service-port', () => backend.getServicePort ());
  ipcMain.handle ('dnd:clear-characters', () => backend.clearCharacters ());

  ipcMain.handle ('dnd:sort-start', async (e, params) => {
    const r = await backend.sortStart (params);
    // Minimize the app so it can't cover the game during sorting.
    if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
    return r;
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
  ipcMain.handle ('dnd:sort-config-get', () => ({
    character_id: settings.dnd?.sort_char_id || '',
    stash_id: settings.dnd?.sort_stash_id || '',
    pack_mode: !!settings.dnd?.pack_mode,
    stack_mode: !!settings.dnd?.stack_mode,
    include_inventory: !!settings.dnd?.sort_include_inv,
  }));
  ipcMain.handle ('dnd:sort-config-save', (e, data = {}) => {
    const dnd = settings.dnd || {};
    if (data.character_id !== undefined) dnd.sort_char_id = String (data.character_id || '');
    if (data.stash_id !== undefined) dnd.sort_stash_id = String (data.stash_id || '');
    if (data.pack_mode !== undefined) dnd.pack_mode = !!data.pack_mode;
    if (data.stack_mode !== undefined) dnd.stack_mode = !!data.stack_mode;
    if (data.include_inventory !== undefined) dnd.sort_include_inv = !!data.include_inventory;
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
    launch_on_startup: !!settings.general.launch_on_startup,
  }));

  ipcMain.handle ('settings:save', (e, data) => {
    let needReregister = false;
    let needSend = false;

    if (data.api_key !== undefined) settings.general.api_key = data.api_key;
    if (data.scan_key !== undefined && data.scan_key !== settings.hotkeys.run_price_check) {
      settings.hotkeys.run_price_check = data.scan_key;
      needReregister = true;
    }
    if (data.default_mode !== undefined) { settings.general.default_mode = data.default_mode; needSend = true; }
    if (data.alignment !== undefined) { settings.general.alignment = data.alignment; needSend = true; }
    if (data.scale !== undefined) { settings.general.scale = parseFloat (data.scale); needSend = true; }
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
    pushBallStatus ();
    return { success: true };
  });

  openHomeWindow ();
  createBallWindow ();
});

async function registerScanHotkey (overlay) {
  let key = settings.hotkeys.run_price_check;
  if (RESERVED_KEYS.includes (key)) key = 'XButton1';

  const mouseMap = {
    'XButton1': 'mousebutton4', 'XButton2': 'mousebutton5',
    'MouseLeft': 'mousebutton0', 'MouseMiddle': 'mousebutton1', 'MouseRight': 'mousebutton2',
    'MouseButton4': 'mousebutton4', 'MouseButton5': 'mousebutton5',
  };

  let accelerator = mouseMap[key] || key;
  let isMouse = accelerator.startsWith ('mousebutton');

  if (previousScanAccelerator && !previousScanAccelerator.startsWith ('mousebutton') && !RESERVED_KEYS.includes (previousScanAccelerator)) {
    try { globalShortcut.unregister (previousScanAccelerator); } catch (e) {}
  }
  if (global._mousePollInterval) { clearInterval (global._mousePollInterval); global._mousePollInterval = null; }

  if (isMouse) {
    const vkMap = { 'mousebutton0': 0x01, 'mousebutton1': 0x04, 'mousebutton2': 0x02, 'mousebutton4': 0x05, 'mousebutton5': 0x06 };
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

function registerSortHotkeys () {
  const sortKey = settings.dnd?.sort_hotkey || 'Ctrl+F11';
  const cancelKey = settings.dnd?.cancel_hotkey || 'Ctrl+F12';

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
          pack_mode: !!settings.dnd?.pack_mode,
          stack_mode: !!settings.dnd?.stack_mode,
          include_inventory: !!settings.dnd?.sort_include_inv,
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
}

function openSettingsWindow (tab) {
  const paneMap = { settings: 'settings', mapping: 'mapping' };
  const pane = paneMap[tab] || 'settings';

  if (!homeWindow) { pendingPane = pane; openHomeWindow (); return; }
  if (homeWindow.isMinimized ()) homeWindow.restore ();
  homeWindow.show ();
  homeWindow.focus ();
  homeWindow.webContents.send ('navigate', pane);
}

function openHomeWindow () {
  if (homeWindow) {
    if (homeWindow.isMinimized ()) homeWindow.restore ();
    homeWindow.show ();
    homeWindow.focus ();
    return;
  }

  homeWindow = new BrowserWindow ({
    width: 1120, height: 740, minWidth: 980, minHeight: 660,
    show: false, title: 'DarkTavern', autoHideMenuBar: true,
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

function defaultBallPos () {
  const wa = screen.getPrimaryDisplay ().workArea;
  return {
    x: wa.x + wa.width - BALL_COLLAPSED.w - 24,
    y: wa.y + Math.round ((wa.height - BALL_COLLAPSED.h) / 2),
  };
}

function ballPosFromSettings () {
  const x = settings.general.ball_x;
  const y = settings.general.ball_y;
  if (x == null || y == null) return defaultBallPos ();

  const wa = screen.getDisplayMatching ({ x, y, width: 20, height: 20 }).workArea;
  return {
    x: Math.min (Math.max (x, wa.x), wa.x + wa.width - BALL_COLLAPSED.w),
    y: Math.min (Math.max (y, wa.y), wa.y + wa.height - BALL_COLLAPSED.h),
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
    width: BALL_COLLAPSED.w,
    height: BALL_COLLAPSED.h,
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
    ballWindow.show ();
    applyBallLock ();
  });
  ballWindow.on ('move', saveBallPos);
  ballWindow.on ('blur', () => {
    if (ballWindow && !ballWindow.isDestroyed ()) ballWindow.webContents.send ('ball:blur');
  });
  ballWindow.on ('closed', () => {
    ballWindow = null;
    if (ballStatusTimer) { clearInterval (ballStatusTimer); ballStatusTimer = null; }
    if (ballDragTimer) { clearInterval (ballDragTimer); ballDragTimer = null; }
    ballDrag = null;
  });

  ballStatusTimer = setInterval (pushBallStatus, 2000);
}

function applyBallLock () {
  if (!ballWindow) return;
  ballWindow.setIgnoreMouseEvents (ballLocked, { forward: true });
  if (ballLocked && ballExpanded) setBallExpanded (false);
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

function setBallExpanded (expanded) {
  ballExpanded = expanded;
  if (!ballWindow || ballWindow.isDestroyed ()) return;

  const size = expanded ? BALL_EXPANDED : BALL_COLLAPSED;
  let [x, y] = ballWindow.getPosition ();
  const wa = screen.getDisplayMatching ({ x, y, width: 20, height: 20 }).workArea;
  x = Math.min (Math.max (x, wa.x), wa.x + wa.width - size.w);
  y = Math.min (Math.max (y, wa.y), wa.y + wa.height - size.h);
  ballWindow.setBounds ({ x, y, width: size.w, height: size.h });
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
  let health = null;
  try { health = await backend.healthRaw (); } catch (e) {}

  let capture = { running: false };
  let sorting = { running: false };
  try { capture = (await backend.captureStatus ()) || capture; } catch (e) {}
  try { sorting = (await backend.sortStatus ()) || sorting; } catch (e) {}

  let current = null;
  try {
    const d = await backend.getCurrentCharacter ();
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

  let lastSortText = '';
  if (sorting.result) {
    lastSortText = sorting.result.success ? '成功 ✓' : ('失败：' + (sorting.result.message || ''));
  } else if (sorting.error) {
    lastSortText = '失败：' + String (sorting.error);
  }

  return {
    locked: ballLocked,
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
    { label: `DarkTavern v${app.getVersion ()}`, enabled: false },
    { type: 'separator' },
    { label: `${dot (ocrStatus)} OCR 侍者：${ocrStatus ? '已就绪' : '唤醒中…'}`, enabled: false },
    { label: `${dot (gameOk)} 游戏窗口：${gameOk ? '已检测到' : '未检测到'}`, enabled: false },
    { type: 'separator' },
    { label: '主页', click: () => openHomeWindow () },
    { label: `${ballLocked ? '○' : '●'} 悬浮球：${ballLocked ? '已锁定' : '已解锁'}（点击切换）`, click: () => setBallLocked (!ballLocked) },
    { type: 'separator' },
    { label: '日志文件夹', click: () => shell.openPath (logPath) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit () }
  ]));

  pushBallStatus ();
}
