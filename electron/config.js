import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname (fileURLToPath (import.meta.url));

export const SOURCE = __dirname;
export const ROOT = join (SOURCE, '..');
export const RESOURCES = process.resourcesPath || join (SOURCE, '..', '..');

export function isDebug () {
  return process.env.NODE_ENV === 'development';
}

// 数据目录：源码运行（未打包，app.isPackaged=false）时放在项目根目录的
// squire_data/ 下，方便本机自用与备份；打包发布后（app.isPackaged=true）
// 仍用 Electron 的 userData（安装目录在 Program Files 不可写）。
export function dataDir (app) {
  if (app && !app.isPackaged) {
    return join (ROOT, 'squire_data');
  }
  try { return app.getPath ('userData'); } catch (e) {}
  return join (ROOT, 'squire_data');
}