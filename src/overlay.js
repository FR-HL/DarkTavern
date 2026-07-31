import { logger } from './logger.js';
import { getWindow } from './backend.js';

const POLL_MS = 200;

let overlay = null;
let timer = null;
let shown = false;
let canScan = false;
let prevBounds = null;

export function getCanScan () {
  return canScan;
}

export function startTracking (overlayWindow) {
  overlay = overlayWindow;
  timer = setInterval (poll, POLL_MS);
}

export function stopTracking () {
  if (timer) { clearInterval (timer); timer = null; }
}

async function poll () {
  if (!overlay) return;

  const data = await getWindow ();

  if (!data) {
    if (shown) {
      overlay.hide ();
      shown = false;
      canScan = false;
      prevBounds = null;
      overlay.webContents.send ('game:state', { canScan: false, visible: false, focused: false });
    }
    return;
  }

  const { bounds, monitor } = data;

  const moved = !prevBounds ||
    bounds.x !== prevBounds.x || bounds.y !== prevBounds.y ||
    bounds.width !== prevBounds.width || bounds.height !== prevBounds.height;

  if (moved) {
    overlay.setBounds ({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    overlay.webContents.send ('game:bounds', {
      ...bounds,
      x: bounds.x - monitor.x,
      y: bounds.y - monitor.y,
      scale: monitor.scale || 1.0,
    });
    prevBounds = bounds;
  }

  if (!shown) {
    overlay.setIgnoreMouseEvents (true, { forward: true });
    overlay.setAlwaysOnTop (true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces (true);
    overlay.show ();
    overlay.moveTop ();
    shown = true;
    logger.info ('Game window found - overlay shown');
  }

  if (!canScan) {
    canScan = true;
    overlay.webContents.send ('game:state', { canScan: true, visible: true, focused: true });
  }
}
