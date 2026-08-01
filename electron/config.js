import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname (fileURLToPath (import.meta.url));

export const SOURCE = __dirname;
export const ROOT = join (SOURCE, '..');
export const RESOURCES = process.resourcesPath || join (SOURCE, '..', '..');

export function isDebug () {
  return process.env.NODE_ENV === 'development';
}