import electron from 'electron';
const { app } = electron;

import merge from 'deepmerge';
import { parse, stringify } from 'ini';
import { logger } from './logger.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const defaults = {
  general: {
    launch_on_startup: false,
    alignment: 'attached',
    components: 'header, primary, secondary, details, quests, pricing',
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

const settingsPath = join (app.getPath ('userData'), 'settings.ini');

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
settings.general.components = toList (settings.general.components, [ 'header', 'primary', 'secondary', 'details', 'quests', 'pricing' ]);
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
settings.general.disclaimer_agreed_version = settings.general.disclaimer_agreed_version || '';
settings.general.auto_check_update = settings.general.auto_check_update === false || settings.general.auto_check_update === 'false' ? false : true;
settings.general.last_update_check = settings.general.last_update_check || '';

settings.hotkeys.run_price_check = settings.hotkeys.run_price_check || 'XButton1';

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

function saveSettings () {
  try {
    writeFileSync (settingsPath, stringify (settings));
  } catch (error) {
    logger.error ('Failed to save settings:', error);
  }
}

export { settings, saveSettings };
