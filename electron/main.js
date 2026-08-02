import electron, { globalShortcut, Menu, shell, Tray } from 'electron';
import { basename, join } from 'node:path';
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
  wire (overlay);

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
  ipcMain.handle ('dnd:clear-characters', () => backend.clearCharacters ());

  ipcMain.handle ('dnd:sort-start', async (e, params) => {
    const r = await backend.sortStart (params);
    // Minimize the app so it can't cover the game during sorting.
    if (r?.success && homeWindow && !homeWindow.isDestroyed ()) homeWindow.minimize ();
    return r;
  });
  ipcMain.handle ('dnd:sort-cancel', () => backend.sortCancel ());
  ipcMain.handle ('dnd:sort-status', () => backend.sortStatus ());
  ipcMain.handle ('dnd:sort-order-get', () => backend.getSortOrder ());
  ipcMain.handle ('dnd:sort-order-set', (e, order) => backend.updateSortOrder (order));
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
    return { success: true };
  });

  openHomeWindow ();
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
    { type: 'separator' },
    { label: '日志文件夹', click: () => shell.openPath (logPath) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit () }
  ]));
}
