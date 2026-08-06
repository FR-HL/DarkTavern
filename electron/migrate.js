// One-time data-directory migration for the rename DarkTavern -> AdventurersSquire.
//
// This module MUST be imported before logger.js and settings.js, because those
// modules read app.getPath('userData') at module-load time. We move any legacy
// userData directory to the new name and point Electron at it before anything
// else touches it.
import electron from 'electron';
const { app } = electron;
import { existsSync, renameSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname (fileURLToPath (import.meta.url));

// 源码运行（未打包）：Chromium profile（缓存 / 会话等）也收进项目内的
// squire_data/，与设置、日志、角色数据同处一地，不在用户目录留任何数据。
if (!app.isPackaged) {
  try {
    const devUserData = join (__dirname, '..', 'squire_data', 'userData');
    mkdirSync (devUserData, { recursive: true });
    app.setPath ('userData', devUserData);
  } catch (e) {
    // best-effort; never block startup
  }
} else {
  const NEW_NAME = 'AdventurersSquire';
  const LEGACY_NAMES = ['DarkTavern', 'darktavern'];

  try {
    const appData = app.getPath ('appData');
    const newDir = join (appData, NEW_NAME);

    for (const legacy of LEGACY_NAMES) {
      const oldDir = join (appData, legacy);
      if (existsSync (oldDir) && !existsSync (newDir)) {
        try {
          renameSync (oldDir, newDir);
        } catch (e) {
          try { cpSync (oldDir, newDir, { recursive: true }); } catch (e2) { /* leave in place */ }
        }
        break;
      }
    }

    // Ensure Electron uses the new directory regardless of package name/productName.
    app.setPath ('userData', newDir);
  } catch (e) {
    // Migration is best-effort; never block startup.
  }
}
