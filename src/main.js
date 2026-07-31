/**
 * GrimVault Chinese Edition - Main Process
 * Overlay application for Dark and Darker price checking with Chinese OCR support.
 */

import electron, { dialog, globalShortcut, Menu, shell, Tray } from 'electron';
import { basename, join } from 'node:path';
import { logger, logPath } from './logger.js';
import { logSystemInformation } from './util.js';
import { checkAndInstallVCRedist } from './vcredist.js';
import { ROOT, SOURCE, isDebug } from './config.js';
import { settings, settingsPath, saveSettings } from './settings.js';
import { pin, handleWindowEvent, setOverlayReference } from './pin.js';
import { wire } from './frontend.js';
import { authServer } from './authServer.js';
import { startWindowHooks, stopWindowHooks } from './native.js';
import * as chinese from './chinese/index.js';

const { app, BrowserWindow } = electron;

let debugging = false;
let overlayRef = null;
const RESERVED_KEYS = ['F5', 'F6', 'F7', 'F8'];

process.on ('uncaughtException', (error) => {
  logger.error ('Uncaught Exception:', error);
  logger.error (`Stack trace: ${error.stack}`);
});

process.on ('unhandledRejection', (reason, promise) => {
  logger.error (`Unhandled Promise Rejection: ${reason.toString ()}`);
  logger.error (`Stack trace: ${reason.stack}`);
});

process.on ('SIGTERM', () => { process.exit (0); });
process.on ('SIGINT', () => { process.exit (0); });
process.on ('exit', () => { logger.info ('Process exiting'); });

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

if (!app.requestSingleInstanceLock ()) {
  app.quit ();
}

app.on ('second-instance', () => { logger.info ('Prevented second instance'); });
app.on ('render-process-gone', (event, webContents, details) => { logger.error (`Render crash: ${JSON.stringify (details)}`); });
app.on ('child-process-gone', (event, details) => { logger.error (`Child crash: ${JSON.stringify (details)}`); });

app.on ('before-quit', () => {
  globalShortcut.unregisterAll ();
  chinese.stopService ();
  try { stopWindowHooks (); } catch (e) {}
});

app.on ('ready', async () => {
  logSystemInformation ();

  // Auto-start Chinese OCR service
  chinese.startService (settings.general.python_path);

  // System tray
  let menu = Menu.buildFromTemplate ([
    { label: `DarkTavern v${app.getVersion ()}`, type: 'normal', enabled: false },
    { type: 'separator' },
    { label: '主页', click: () => { openHomeWindow (); } },
    { label: `Scan Key: ${settings.hotkeys.run_price_check}`, type: 'normal', enabled: false },
    { label: '设置 (F5)', click: () => { openSettingsWindow ('settings'); } },
    { label: '词条编辑 (F6)', click: () => { openSettingsWindow ('mapping'); } },
    { type: 'separator' },
    { label: 'Logs', click: () => { shell.openPath (logPath); } },
    { label: 'Settings File', click: () => { shell.openPath (settingsPath); } },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.quit (); } }
  ]);

  let tray = new Tray (join (ROOT, 'assets/images/Icon-81x89.png'));
  tray.setToolTip ('DarkTavern');
  tray.setContextMenu (menu);

  // Create overlay window
  let overlay = new BrowserWindow ({
    backgroundColor: '#00000000',
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    type: 'toolbar',
    webPreferences: {
      preload: join (SOURCE, 'preload.cjs'),
      sandbox: false,
      backgroundThrottling: true
    },
  });

  overlay.webContents.setZoomFactor (1);

  // Event-driven overlay positioning
  setOverlayReference (overlay, debugging);

  try {
    const success = startWindowHooks ((eventData) => { handleWindowEvent (eventData); });
    if (!success) logger.error ('Failed to start window event hooks');
  } catch (error) {
    logger.error ('Error starting window event hooks:', error);
  }

  // Fallback polling
  setInterval (() => { pin (overlay, debugging); }, 30000);

  wire (overlay);

  const vcredistInstalled = await checkAndInstallVCRedist (overlay);
  if (!vcredistInstalled) {
    logger.error ('Visual C++ Redistributable not installed');
    app.quit ();
    return;
  }

  try { await authServer.start (); } catch (error) {
    logger.error ('Failed to start auth server:', error);
  }

  overlay.loadFile (join (ROOT, 'ui', 'overlay', 'dist', 'index.html'));

  overlayRef = overlay;

  // F5 = Open settings panel
  globalShortcut.register ('F5', () => { openSettingsWindow ('settings'); });

  // F6 = Open mapping editor
  globalShortcut.register ('F6', () => { openSettingsWindow ('mapping'); });

  // F7 = Debug mode
  globalShortcut.register ('F7', () => {
    overlay.webContents.send ('manual:debugger');
    debugging = !debugging;
    if (debugging) {
      overlay.webContents.openDevTools ({ mode: 'detach' });
    } else {
      overlay.webContents.closeDevTools ();
    }
  });

  // F8 = Clear tooltip
  globalShortcut.register ('F8', () => { overlay.webContents.send ('clear'); });

  // Register user-configured scan hotkey (after reserved keys)
  registerScanHotkey (overlay, RESERVED_KEYS);

  // IPC: settings window can save settings in real-time
  const frontend = electron.ipcMain;

  frontend.handle ('settings:get', () => {
    return {
      api_key: settings.general.api_key || '',
      scan_key: settings.hotkeys.run_price_check || 'XButton1',
      default_mode: settings.general.default_mode || 'manual',
      alignment: settings.general.alignment || 'attached',
      scale: settings.general.scale || 1.0,
      launch_on_startup: !!settings.general.launch_on_startup,
    };
  });

  frontend.handle ('settings:save', (event, data) => {
    let needReregister = false;
    let needSend = false;

    if (data.api_key !== undefined) {
      settings.general.api_key = data.api_key;
    }

    if (data.scan_key !== undefined && data.scan_key !== settings.hotkeys.run_price_check) {
      settings.hotkeys.run_price_check = data.scan_key;
      needReregister = true;
    }

    if (data.default_mode !== undefined) {
      settings.general.default_mode = data.default_mode;
      needSend = true;
    }

    if (data.alignment !== undefined) {
      settings.general.alignment = data.alignment;
      needSend = true;
    }

    if (data.scale !== undefined) {
      settings.general.scale = parseFloat (data.scale);
      needSend = true;
    }

    if (data.launch_on_startup !== undefined) {
      settings.general.launch_on_startup = !!data.launch_on_startup;
      app.setLoginItemSettings ({
        openAtLogin: settings.general.launch_on_startup,
        path: process.execPath,
        args: ['--processStart', `${basename (process.execPath)}`, '--process-start-args', '--hidden']
      });
    }

    saveSettings ();
    logger.info (`Settings saved: ${JSON.stringify (data)}`);

    if (needSend) {
      overlay.webContents.send ('settings', settings);
    }

    // Re-register scan hotkey if changed
    if (needReregister) {
      registerScanHotkey (overlay, RESERVED_KEYS);
    }

    return { success: true };
  });

  // Single-window app: the home window hosts overview + settings + mapping panes
  // behind its sidebar. The Python OCR service keeps loading in the background;
  // the home page polls /health and lights up its status in real time.
  openHomeWindow ();
});

// Track previously registered scan key so we can unregister it
let previousScanAccelerator = null;

// Register the user-configured scan hotkey
async function registerScanHotkey (overlay, reservedKeys) {
  let key = settings.hotkeys.run_price_check;

  // Don't allow reserved keys as scan key
  if (reservedKeys && reservedKeys.includes (key)) {
    logger.warn (`Scan key ${key} conflicts with system shortcut, using XButton1`);
    key = 'XButton1';
    settings.hotkeys.run_price_check = key;
  }

  // Map mouse button names to internal format
  let mouseKeyMap = {
    'XButton1': 'mousebutton4',
    'XButton2': 'mousebutton5',
    'MouseLeft': 'mousebutton0',
    'MouseMiddle': 'mousebutton1',
    'MouseRight': 'mousebutton2',
    'MouseButton4': 'mousebutton4',
    'MouseButton5': 'mousebutton5',
  };

  let accelerator = mouseKeyMap [key] || key;
  let isMouse = accelerator.startsWith ('mousebutton');

  // Unregister previous scan key (keyboard only, not reserved keys)
  if (previousScanAccelerator && !previousScanAccelerator.startsWith ('mousebutton')) {
    const RESERVED = ['F5', 'F6', 'F7', 'F8'];
    if (!RESERVED.includes (previousScanAccelerator)) {
      try { globalShortcut.unregister (previousScanAccelerator); } catch (e) {}
      logger.info (`Unregistered old scan key: ${previousScanAccelerator}`);
    }
  }

  // Clear previous mouse polling
  if (global._mousePollInterval) {
    clearInterval (global._mousePollInterval);
    global._mousePollInterval = null;
  }

  if (isMouse) {
    // Use koffi + GetAsyncKeyState to detect mouse buttons in main process
    // VK codes: VK_LBUTTON=0x01, VK_RBUTTON=0x02, VK_MBUTTON=0x04, VK_XBUTTON1=0x05, VK_XBUTTON2=0x06
    const vkMap = {
      'mousebutton0': 0x01, 'mousebutton1': 0x04, 'mousebutton2': 0x02,
      'mousebutton3': 0x05, 'mousebutton4': 0x05, 'mousebutton5': 0x06,
    };
    const vkCode = vkMap [accelerator] || 0x05;

    // Clear previous polling
    if (global._mousePollInterval) {
      clearInterval (global._mousePollInterval);
      global._mousePollInterval = null;
    }

    try {
      const { createRequire } = await import ('node:module');
      const _require = createRequire (import.meta.url);
      const koffi = _require ('koffi');
      const user32 = koffi.load ('user32.dll');
      const GetAsyncKeyState = user32.func ('short __stdcall GetAsyncKeyState(int vKey)');

      let wasPressed = false;
      global._mousePollInterval = setInterval (() => {
        const state = GetAsyncKeyState (vkCode);
        const isPressed = (state & 0x8000) !== 0;
        if (isPressed && !wasPressed) {
          overlay.webContents.send ('manual:scan');
        }
        wasPressed = isPressed;
      }, 100);

      logger.info (`Scan mouse button registered via GetAsyncKeyState: VK=0x${vkCode.toString (16)}`);
    } catch (e) {
      logger.error (`Failed to setup mouse polling: ${e.message}`);
    }
    logger.info (`Scan key set to mouse button: ${key}`);
  } else {
    try {
      globalShortcut.register (accelerator, () => {
        overlay.webContents.send ('manual:scan');
      });
      logger.info (`Scan key registered: ${key}`);
    } catch (e) {
      logger.error (`Failed to register scan key ${key}: ${e.message}`);
    }
  }

  previousScanAccelerator = accelerator;
}

// Navigate the single-window app to a pane (overview / general / scan / mapping).
// Used by the tray menu and the F5 / F6 global shortcuts; the home window hosts
// every pane behind its sidebar, so there is no separate settings window anymore.
let pendingPane = null;

function openSettingsWindow (tab) {
  const paneMap = { settings: 'general', keybind: 'scan', general: 'general', scan: 'scan', mapping: 'mapping', overview: 'overview' };
  const pane = paneMap [tab] || 'general';

  if (!homeWindow) {
    pendingPane = pane;
    openHomeWindow ();
    return;
  }

  if (homeWindow.isMinimized ()) homeWindow.restore ();
  homeWindow.show ();
  homeWindow.focus ();
  homeWindow.webContents.send ('navigate', pane);
}

// Home window - the application entry point (real main page, OCR loads in background)
let homeWindow = null;

function openHomeWindow () {
  if (homeWindow) {
    if (homeWindow.isMinimized ()) homeWindow.restore ();
    homeWindow.show ();
    homeWindow.focus ();
    return;
  }

  let homePath = join (ROOT, 'home.html');

  homeWindow = new BrowserWindow ({
    width: 1120,
    height: 740,
    minWidth: 980,
    minHeight: 660,
    show: false,
    title: 'DarkTavern',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  homeWindow.webContents.on ('console-message', (e, level, message) => {
    logger.debug (`[home console] ${message}`);
  });
  homeWindow.webContents.on ('did-fail-load', (e, code, desc, url) => {
    logger.error (`[home] did-fail-load ${code} ${desc} ${url}`);
  });
  homeWindow.webContents.on ('did-finish-load', () => {
    if (pendingPane) {
      homeWindow.webContents.send ('navigate', pendingPane);
      pendingPane = null;
    }
  });

  homeWindow.loadFile (homePath);

  homeWindow.once ('ready-to-show', () => {
    homeWindow.show ();
    homeWindow.focus ();
  });

  homeWindow.on ('closed', () => {
    homeWindow = null;
  });
}
