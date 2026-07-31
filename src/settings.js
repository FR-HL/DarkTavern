import electron from 'electron';
const { app } = electron;

import { __dirname } from './config.js';
import merge from 'deepmerge';
import { parse, stringify } from 'ini';
import { logger } from './logger.js';
import { existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const settingsPath = join (app.getPath ('userData'), 'settings.ini');
const defaultsPath = join (__dirname, '..', 'settings.ini');

let settings = {};

if (existsSync (settingsPath)) {
  let raw = readFileSync (settingsPath).toString ();
  try {
    settings = parse (raw);
  } catch (e) {
    logger.error (`Failed to parse settings: ${settingsPath}`);
  }
} else {
  copyFileSync (defaultsPath, settingsPath);
}

let template = readFileSync (defaultsPath).toString ();
let defaults = parse (template);

settings = merge (defaults, settings);

settings.general.launch_on_startup = toBool (settings.general.launch_on_startup);
settings.general.alignment = toEnum (settings.general.alignment, [ 'attached', 'top-left', 'top-right', 'bottom-left', 'bottom-right' ]);
settings.general.components = toList (settings.general.components, [ 'header', 'primary', 'secondary', 'details', 'quests', 'pricing' ]);
settings.general.scale = parseFloat (settings.general.scale || '1.0');
settings.general.default_mode = settings.general.default_mode || 'manual';
settings.general.python_path = settings.general.python_path || 'python';
settings.general.api_key = settings.general.api_key || '';

settings.hotkeys.run_price_check = settings.hotkeys.run_price_check || 'XButton1';

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
    const settingsString = stringify (settings);
    writeFileSync (settingsPath, settingsString);
  } catch (error) {
    logger.error ('Failed to save settings:', error);
  }
}

export { settings, settingsPath, saveSettings };
