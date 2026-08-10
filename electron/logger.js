import electron from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import winston from 'winston';
import 'winston-daily-rotate-file';
import { isDebug, dataDir } from './config.js';

const { app } = electron;
const logPath = join (dataDir (app), 'logs');

if (!existsSync (logPath)) {
  mkdirSync (logPath, { recursive: true });
}

// ── 统一格式：单行人类可读，毫秒级时间戳 + 模块标签 ──
// [2026-08-10 12:00:00.123] [LEVEL] [module] 消息 | {"meta":"紧凑JSON"}
// 文件输出级别大写；控制台输出保留小写（colorize 依赖小写 level，且
// toUpperCase 会破坏 ANSI 色码里的 'm'）。
const fileFormat = winston.format.printf (({ level, message, timestamp, module, ...meta }) => {
  const mod = module || 'app';
  const metaStr = Object.keys (meta).length ? ` | ${JSON.stringify (meta)}` : '';
  return `[${timestamp}] [${String (level).toUpperCase ()}] [${mod}] ${message}${metaStr}`;
});
const consoleFormat = winston.format.printf (({ level, message, timestamp, module, ...meta }) => {
  const mod = module || 'app';
  const metaStr = Object.keys (meta).length ? ` | ${JSON.stringify (meta)}` : '';
  return `[${timestamp}] [${level}] [${mod}] ${message}${metaStr}`;
});

const logger = winston.createLogger ({
  // 默认精简级别：普通用户只记关键流程（info 级，低频）；
  // 开发者模式 / 开发环境由 setLogLevel 提升为完整 debug。
  level: 'info',
  format: winston.format.combine (
    winston.format.timestamp ({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    fileFormat
  ),
  transports: [
    new winston.transports.DailyRotateFile ({
      filename: join (logPath, '%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '2m',
      maxFiles: 2, // 保留 2 天
      zippedArchive: false,
    }),
  ],
});

// ── 环形缓冲（最近 500 条结构化日志）：日志面板 + 崩溃现场 ──

const RING_SIZE = 500;
const ring = [];

// ── 敏感字段脱敏（兜底防线）：api_key / token / secret / password 等
// 无论哪里误打，写入文件/环形缓冲/dump 前统一打码。
const SENSITIVE_KEYS = /(api[_-]?key|apikey|token|secret|password|passwd|authorization|auth|credential)/i;
const REDACTED = '***';

function sanitizeValue (key, value) {
  if (typeof value === 'string' && SENSITIVE_KEYS.test (key)) return REDACTED;
  return value;
}

function sanitizeMeta (meta, depth = 0) {
  if (depth > 4 || meta === null || typeof meta !== 'object') return meta;
  if (Array.isArray (meta)) return meta.map ((v) => sanitizeMeta (v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries (meta)) {
    if (typeof v === 'string' && SENSITIVE_KEYS.test (k)) { out[k] = REDACTED; continue; }
    if (v && typeof v === 'object') { out[k] = sanitizeMeta (v, depth + 1); continue; }
    out[k] = v;
  }
  return out;
}

function toEntry (info) {
  const { timestamp, level, message, module, ...meta } = info;
  return {
    ts: timestamp || new Date ().toISOString (),
    level: String (level || 'info').toLowerCase (),
    module: module || 'app',
    message: String (message ?? ''),
    meta: sanitizeMeta (meta),
  };
}

const logListeners = new Set ();

class RingBufferTransport extends winston.Transport {
  constructor (opts) {
    super (opts);
    this.name = 'ringBuffer';
  }

  log (info, callback) {
    try {
      const entry = toEntry (info);
      ring.push (entry);
      if (ring.length > RING_SIZE) ring.shift ();
      for (const cb of logListeners) {
        try { cb (entry); } catch (e) {}
      }
    } catch (e) {}
    callback ();
  }
}

logger.add (new RingBufferTransport ({}));

// ── 对外接口 ──

// 运行时切换日志级别（开发者模式开关）；开发环境恒为 debug
export function setLogLevel (level) {
  if (isDebug ()) {
    logger.level = 'debug';
    return;
  }
  logger.level = level;
}

export function getRing () {
  return [...ring];
}

// 订阅每条新日志（主进程用它推送到前端日志面板）
export function onLog (cb) {
  logListeners.add (cb);
  return () => logListeners.delete (cb);
}

// 崩溃现场：错误堆栈 + 最近 500 条日志 → logs/crash-<ts>.log
export function dumpCrash (title, err) {
  try {
    const now = new Date ();
    const stamp = now.toISOString ().replace (/[:.]/g, '-');
    const file = join (logPath, `crash-${stamp}.log`);
    const detail = err instanceof Error
      ? (err.stack || err.message)
      : JSON.stringify (err, null, 2);
    const lines = [
      `=== ${title} @ ${now.toLocaleString ()} ===`,
      '--- 错误信息 ---',
      detail,
      '',
      `--- 最近 ${ring.length} 条日志 ---`,
      ...ring.map ((e) => `[${e.ts}] [${String (e.level).toUpperCase ()}] [${e.module}] ${e.message}${Object.keys (e.meta || {}).length ? ` | ${JSON.stringify (e.meta)}` : ''}`),
    ];
    writeFileSync (file, lines.join ('\n') + '\n', 'utf-8');
    return file;
  } catch (e) {
    return null;
  }
}

if (isDebug ()) {
  logger.add (new winston.transports.Console ({
    format: winston.format.combine (
      winston.format.timestamp ({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.colorize ({ all: false, level: true }),
      consoleFormat
    ),
  }));
  logger.level = 'debug';
}

export { logger, logPath };
