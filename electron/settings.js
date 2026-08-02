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
  },
  hotkeys: {
    run_price_check: 'XButton1',
  },
  dnd: {
    sort_hotkey: 'Ctrl+F11',
    cancel_hotkey: 'Ctrl+F12',
    capture_interface: 'Ethernet',
    capture_port_low: 20200,
    capture_port_high: 20300,
    wireshark_path: '',
    sort_speed: 0.2,
    pack_mode: false,
    stack_mode: false,
    sort_char_id: '',
    sort_stash_id: '',
    sort_include_inv: false,
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

settings.hotkeys.run_price_check = settings.hotkeys.run_price_check || 'XButton1';

settings.dnd.sort_hotkey = settings.dnd.sort_hotkey || 'Ctrl+F11';
settings.dnd.cancel_hotkey = settings.dnd.cancel_hotkey || 'Ctrl+F12';
settings.dnd.capture_interface = settings.dnd.capture_interface || 'Ethernet';
settings.dnd.capture_port_low = parseInt (settings.dnd.capture_port_low) || 20200;
settings.dnd.capture_port_high = parseInt (settings.dnd.capture_port_high) || 20300;
settings.dnd.wireshark_path = settings.dnd.wireshark_path || '';
settings.dnd.sort_speed = parseFloat (settings.dnd.sort_speed) || 0.2;
settings.dnd.pack_mode = toBool (settings.dnd.pack_mode);
settings.dnd.stack_mode = toBool (settings.dnd.stack_mode);

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
