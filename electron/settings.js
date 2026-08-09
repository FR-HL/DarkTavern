import electron from 'electron';
const { app } = electron;

import merge from 'deepmerge';
import { parse, stringify } from 'ini';
import { logger } from './logger.js';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dataDir } from './config.js';

// 查价悬浮窗可显示项。demand/adventure 属「详情」，market/live/vendor/density 属「价格」。
const COMPONENT_KEYS = [ 'header', 'primary', 'secondary', 'demand', 'adventure', 'quests', 'market', 'live', 'vendor', 'density' ];
// 旧版粗粒度键（details/pricing）。旧格式没有逐项自定义，检测到时整体落到新默认。
const LEGACY_COMPONENT_KEYS = [ 'details', 'pricing' ];
// 新默认：市场均价开、任务物品关（density 默认关）。
const DEFAULT_COMPONENTS = [ 'header', 'primary', 'secondary', 'demand', 'adventure', 'market', 'live', 'vendor' ];

const defaults = {
  general: {
    launch_on_startup: false,
    alignment: 'attached',
    components: DEFAULT_COMPONENTS.join (', '),
    scale: '1.0',
    default_mode: 'manual',
    python_path: 'python',
    api_key: '',
    ball_x: null,
    ball_y: null,
    ball_locked: false,
    ball_visible: true,
    developer_mode: false,
    theme: 'light',
    font_scale: '1.0',
    disclaimer_agreed_version: '',
    auto_check_update: true,
    last_update_check: '',
  },
  hotkeys: {
    run_price_check: 'XButton1',
  },
  dnd: {
    sort_hotkey: 'Ctrl+R',
    cancel_hotkey: 'Ctrl+T',
    stash_next_key: 'Ctrl+E',
    cross_hotkey: 'Ctrl+F12',
    capture_interface: 'Ethernet',
    capture_port_low: 20200,
    capture_port_high: 20300,
    wireshark_path: '',
    sort_speed: 0.2,
    stack_mode: false,
    sort_char_id: '',
    sort_stash_id: '',
    sort_include_inv: false,
    follow_mode: 'click',
    cross_config: '',
  },
};

const settingsPath = join (dataDir (app), 'settings.ini');

let settings = {};

if (existsSync (settingsPath)) {
  try {
    settings = parse (readFileSync (settingsPath).toString ());
  } catch (e) {
    logger.error (`Failed to parse settings: ${settingsPath}`);
  }
}

settings = merge (defaults, settings);

settings.general.launch_on_startup = toBool (settings.general.launch_on_startup);
settings.general.alignment = toEnum (settings.general.alignment, [ 'attached', 'top-left', 'top-right', 'bottom-left', 'bottom-right' ]);
settings.general.components = toComponents (settings.general.components);
settings.general.scale = parseFloat (settings.general.scale || '1.0');
settings.general.default_mode = settings.general.default_mode || 'manual';
settings.general.python_path = settings.general.python_path || 'python';
settings.general.api_key = settings.general.api_key || '';
settings.general.ball_x = settings.general.ball_x == null ? null : parseInt (settings.general.ball_x) || null;
settings.general.ball_y = settings.general.ball_y == null ? null : parseInt (settings.general.ball_y) || null;
settings.general.ball_locked = toBool (settings.general.ball_locked);
settings.general.ball_visible = toBool (settings.general.ball_visible);
settings.general.developer_mode = toBool (settings.general.developer_mode);
settings.general.theme = settings.general.theme === 'dark' ? 'dark' : 'light';
settings.general.font_scale = parseFloat (settings.general.font_scale) || 1.0;
settings.general.disclaimer_agreed_version = settings.general.disclaimer_agreed_version || '';
settings.general.auto_check_update = settings.general.auto_check_update === false || settings.general.auto_check_update === 'false' ? false : true;
settings.general.last_update_check = settings.general.last_update_check || '';

settings.hotkeys.run_price_check = (/^(Mouse(Left|Right))$/.test (settings.hotkeys.run_price_check)) ? 'XButton1' : (settings.hotkeys.run_price_check || 'XButton1');

settings.dnd.sort_hotkey = settings.dnd.sort_hotkey || 'Ctrl+R';
settings.dnd.cancel_hotkey = settings.dnd.cancel_hotkey || 'Ctrl+T';
settings.dnd.stash_next_key = settings.dnd.stash_next_key || 'Ctrl+E';
settings.dnd.cross_hotkey = settings.dnd.cross_hotkey || 'Ctrl+F12';
settings.dnd.capture_interface = settings.dnd.capture_interface || 'Ethernet';
settings.dnd.capture_port_low = parseInt (settings.dnd.capture_port_low) || 20200;
settings.dnd.capture_port_high = parseInt (settings.dnd.capture_port_high) || 20300;
settings.dnd.wireshark_path = settings.dnd.wireshark_path || '';
settings.dnd.sort_speed = parseFloat (settings.dnd.sort_speed) || 0.2;
settings.dnd.stack_mode = toBool (settings.dnd.stack_mode);
settings.dnd.follow_mode = ['off', 'click', 'pixel'].includes (settings.dnd.follow_mode) ? settings.dnd.follow_mode : 'click';
settings.dnd.cross_config = settings.dnd.cross_config || '';

function toBool (s) {
  if (s === true || s === 'true') return true;
  if (s === false || s === 'false') return false;
  return true;
}

function toEnum (s, values) {
  if (values.indexOf (s) === -1) return values [0];
  return s;
}

function toList (s, values) {
  if (!s) return values;
  if (Array.isArray (s)) return s.filter (v => values.includes (v));
  s = s.split (/ *, */g);
  s = s.filter (v => values.includes (v));
  return s;
}

function toComponents (s) {
  if (!s) return [ ...DEFAULT_COMPONENTS ];
  const list = toList (s, COMPONENT_KEYS.concat (LEGACY_COMPONENT_KEYS));
  if (!list.length) return [ ...DEFAULT_COMPONENTS ];
  if (list.some (k => LEGACY_COMPONENT_KEYS.includes (k))) return [ ...DEFAULT_COMPONENTS ];
  return list.filter (k => COMPONENT_KEYS.includes (k));
}

function saveSettings () {
  try {
    mkdirSync (dirname (settingsPath), { recursive: true });
    writeFileSync (settingsPath, stringify (settings));
  } catch (error) {
    logger.error ('Failed to save settings:', error);
  }
}

export { settings, saveSettings, toComponents };
