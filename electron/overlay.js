import { screen } from 'electron';
import { logger as rootLogger } from './logger.js';
import { createRequire } from 'node:module';

const logger = rootLogger.child ({ module: 'overlay' });

const _require = createRequire (import.meta.url);
const koffi = _require ('koffi');
const user32 = koffi.load ('user32.dll');

const RECT = koffi.struct ('_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

const WinEventProc = koffi.proto ('void WinEventProc(void *hWinEventHook, uint event, void *hwnd, long idObject, long idChild, uint dwEventThread, uint dwmsEventTime)');
const WinEventProcPtr = koffi.pointer (WinEventProc);
const EnumWindowsProc = koffi.proto ('bool EnumWindowsProc(void *hwnd, long lParam)');

const FindWindowW = user32.func ('void *FindWindowW(str16 lpClassName, str16 lpWindowName)');
const EnumWindows = user32.func ('bool EnumWindows(EnumWindowsProc *cb, long lParam)');
const GetWindowTextW = user32.func ('int GetWindowTextW(void *hwnd, _Out_ char16 *lpString, int nMaxCount)');
const GetWindowTextLengthW = user32.func ('int GetWindowTextLengthW(void *hwnd)');
const GetWindowRect = user32.func ('bool GetWindowRect(void *hWnd, _Out_ _RECT *lpRect)');
const IsWindowVisible = user32.func ('bool IsWindowVisible(void *hWnd)');
const SetWinEventHook = user32.func ('void *SetWinEventHook(uint eventMin, uint eventMax, void *hmodWinEventProc, WinEventProc *pfnWinEventProc, uint idProcess, uint idThread, uint dwFlags)');
const UnhookWinEvent = user32.func ('bool UnhookWinEvent(void *hWinEventHook)');
const GetWindowThreadProcessId = user32.func ('uint GetWindowThreadProcessId(void *hWnd, _Out_ uint *lpdwProcessId)');
const SetForegroundWindow = user32.func ('bool SetForegroundWindow(void *hWnd)');

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

export function activateGameWindow () {
  if (!trackedHwnd) return;
  try { SetForegroundWindow (trackedHwnd); } catch (e) {}
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

function windowTitle (hwnd) {
  try {
    const n = GetWindowTextLengthW (hwnd);
    if (n <= 0) return '';
    const buf = koffi.alloc ('char16', n + 1);
    GetWindowTextW (hwnd, buf, n + 1);
    return koffi.decode (buf, 'char16', n).trim ();
  } catch (e) { return ''; }
}

function findGameWindow () {
  // 枚举所有同标题的可见窗口，选面积最大的真实游戏窗口。
  // FindWindowW 只返回第一个匹配——可能命中最小化/幽灵窗口
  // （-32000 屏幕外 160×28），导致悬浮窗被定位到屏幕外。
  let best = null;
  let bestArea = 0;
  let cb = null;
  try {
    cb = koffi.register ((hwnd, lParam) => {
      try {
        const title = windowTitle (hwnd).toLowerCase ();
        if (!GAME_TITLES.some (t => t.trim ().toLowerCase () === title)) return true;
        if (!IsWindowVisible (hwnd)) return true;
        const rect = {};
        if (!GetWindowRect (hwnd, rect)) return true;
        const w = rect.right - rect.left;
        const h = rect.bottom - rect.top;
        if (rect.left < -10000 || rect.top < -10000) return true; // 最小化 / 屏幕外
        if (w < 200 || h < 150) return true;                       // 过滤极小窗口
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = hwnd; }
      } catch (e) {}
      return true;
    }, koffi.pointer (EnumWindowsProc));
    EnumWindows (cb, 0);
  } catch (e) { return null; }
  finally {
    try { if (cb) koffi.unregister (cb); } catch (e) {}
  }
  return best;
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
  logger.info ('游戏窗口消失，悬浮层隐藏');

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
  logger.info ('悬浮窗窗口定位', {
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    monitor: { x: monitor.x, y: monitor.y, scale: monitor.scale },
  });
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
  overlay.showInactive ();
  overlay.moveTop ();
  shown = true;
  canScan = true;

  overlay.webContents.send ('game:state', { canScan: true, visible: true, focused: true });
  if (onStateChange) onStateChange (true);
  logger.info ('检测到游戏窗口，悬浮层已显示');
}
