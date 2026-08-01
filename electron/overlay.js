import { screen } from 'electron';
import { logger } from './logger.js';
import { createRequire } from 'node:module';

const _require = createRequire (import.meta.url);
const koffi = _require ('koffi');
const user32 = koffi.load ('user32.dll');

const RECT = koffi.struct ('_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

const WinEventProc = koffi.proto ('void WinEventProc(void *hWinEventHook, uint event, void *hwnd, long idObject, long idChild, uint dwEventThread, uint dwmsEventTime)');
const WinEventProcPtr = koffi.pointer (WinEventProc);

const FindWindowW = user32.func ('void *FindWindowW(str16 lpClassName, str16 lpWindowName)');
const GetWindowRect = user32.func ('bool GetWindowRect(void *hWnd, _Out_ _RECT *lpRect)');
const IsWindowVisible = user32.func ('bool IsWindowVisible(void *hWnd)');
const SetWinEventHook = user32.func ('void *SetWinEventHook(uint eventMin, uint eventMax, void *hmodWinEventProc, WinEventProc *pfnWinEventProc, uint idProcess, uint idThread, uint dwFlags)');
const UnhookWinEvent = user32.func ('bool UnhookWinEvent(void *hWinEventHook)');
const GetWindowThreadProcessId = user32.func ('uint GetWindowThreadProcessId(void *hWnd, _Out_ uint *lpdwProcessId)');

const EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
const EVENT_OBJECT_DESTROY = 0x8001;
const WINEVENT_OUTOFCONTEXT = 0x0000;

const GAME_TITLES = ['Dark and Darker  ', 'Dark and Darker'];
const DETECT_INTERVAL = 3000;

let overlay = null;
let detectTimer = null;
let hookLocation = null;
let hookDestroy = null;
let hookCallbackLocation = null;
let hookCallbackDestroy = null;
let shown = false;
let canScan = false;
let prevBounds = null;
let trackedHwnd = null;
let onStateChange = null;

export function getCanScan () {
  return canScan;
}

export function resendState () {
  if (!overlay || !canScan) return;
  overlay.webContents.send ('game:state', { canScan: true, visible: true, focused: true });
  if (prevBounds) {
    const monitor = getMonitorInfo (prevBounds);
    overlay.webContents.send ('game:bounds', {
      ...prevBounds,
      x: prevBounds.x - monitor.x,
      y: prevBounds.y - monitor.y,
      scale: monitor.scale,
    });
  }
}

export function setOnStateChange (cb) {
  onStateChange = cb;
}

export function startTracking (overlayWindow) {
  overlay = overlayWindow;
  tryDetect ();
  detectTimer = setInterval (tryDetect, DETECT_INTERVAL);
}

export function stopTracking () {
  if (detectTimer) { clearInterval (detectTimer); detectTimer = null; }
  removeHooks ();
}

function findGameWindow () {
  for (const title of GAME_TITLES) {
    const hwnd = FindWindowW (null, title);
    if (hwnd && IsWindowVisible (hwnd)) return hwnd;
  }
  return null;
}

function tryDetect () {
  if (trackedHwnd) return;

  const hwnd = findGameWindow ();
  if (!hwnd) return;

  trackedHwnd = hwnd;
  if (detectTimer) { clearInterval (detectTimer); detectTimer = null; }

  updateBounds ();
  showOverlay ();
  installHooks ();
}

function installHooks () {
  const pid = [0];
  const threadId = GetWindowThreadProcessId (trackedHwnd, pid);

  hookCallbackLocation = koffi.register ((hook, event, hwnd, idObject, idChild, thread, time) => {
    if (hwnd === trackedHwnd) updateBounds ();
  }, WinEventProcPtr);

  hookCallbackDestroy = koffi.register ((hook, event, hwnd, idObject, idChild, thread, time) => {
    if (hwnd === trackedHwnd) onWindowLost ();
  }, WinEventProcPtr);

  hookLocation = SetWinEventHook (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, null, hookCallbackLocation, 0, threadId, WINEVENT_OUTOFCONTEXT);
  hookDestroy = SetWinEventHook (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, null, hookCallbackDestroy, 0, threadId, WINEVENT_OUTOFCONTEXT);
}

function removeHooks () {
  if (hookLocation) { UnhookWinEvent (hookLocation); hookLocation = null; }
  if (hookDestroy) { UnhookWinEvent (hookDestroy); hookDestroy = null; }
  if (hookCallbackLocation) { koffi.unregister (hookCallbackLocation); hookCallbackLocation = null; }
  if (hookCallbackDestroy) { koffi.unregister (hookCallbackDestroy); hookCallbackDestroy = null; }
}

function onWindowLost () {
  removeHooks ();
  trackedHwnd = null;
  prevBounds = null;

  if (shown && overlay) {
    overlay.hide ();
    shown = false;
  }
  if (canScan) {
    canScan = false;
    if (overlay) overlay.webContents.send ('game:state', { canScan: false, visible: false, focused: false });
    if (onStateChange) onStateChange (false);
  }

  detectTimer = setInterval (tryDetect, DETECT_INTERVAL);
}

function updateBounds () {
  if (!trackedHwnd || !overlay) return;

  const rect = {};
  if (!GetWindowRect (trackedHwnd, rect)) { onWindowLost (); return; }

  const bounds = {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  };

  const moved = !prevBounds ||
    bounds.x !== prevBounds.x || bounds.y !== prevBounds.y ||
    bounds.width !== prevBounds.width || bounds.height !== prevBounds.height;

  if (!moved) return;

  const monitor = getMonitorInfo (bounds);
  overlay.setBounds ({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  overlay.webContents.send ('game:bounds', {
    ...bounds,
    x: bounds.x - monitor.x,
    y: bounds.y - monitor.y,
    scale: monitor.scale,
  });
  prevBounds = bounds;
}

function getMonitorInfo (bounds) {
  const display = screen.getDisplayMatching ({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  return {
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
    scale: display.scaleFactor || 1.0,
  };
}

function showOverlay () {
  if (!overlay) return;

  overlay.setIgnoreMouseEvents (true, { forward: true });
  overlay.setAlwaysOnTop (true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces (true);
  overlay.show ();
  overlay.moveTop ();
  shown = true;
  canScan = true;

  overlay.webContents.send ('game:state', { canScan: true, visible: true, focused: true });
  if (onStateChange) onStateChange (true);
  logger.info ('Game window found - overlay shown');
}
