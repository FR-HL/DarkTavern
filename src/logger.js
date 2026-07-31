import electron from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import winston from 'winston';
import 'winston-daily-rotate-file';
import { isDebug } from './config.js';

const { app } = electron;
const logPath = join (app.getPath ('userData'), 'logs');

if (!existsSync (logPath)) {
  mkdirSync (logPath, { recursive: true });
}

const logger = winston.createLogger ({
  level: isDebug () ? 'debug' : 'info',
  format: winston.format.combine (
    winston.format.timestamp (),
    winston.format.printf (({ level, message, timestamp, ...meta }) => {
      return `${timestamp} [${level}] ${message} ${Object.keys (meta).length ? JSON.stringify (meta, null, 2) : ''}`;
    })
  ),
  transports: [
    new winston.transports.DailyRotateFile ({
      filename: join (logPath, '%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '2m',
      maxFiles: 5,
      zippedArchive: false,
    })
  ]
});

if (isDebug ()) {
  logger.add (new winston.transports.Console ({
    format: winston.format.combine (
      winston.format.timestamp (),
      winston.format.colorize ({ all: false, level: true }),
      winston.format.printf (({ level, message, timestamp, ...meta }) => {
        const metaStr = Object.keys (meta).length ? `\x1b[90m${JSON.stringify (meta, null, 2)}\x1b[0m` : '';
        return `${timestamp} [${level}] ${message} ${metaStr}`;
      })
    )
  }));
}

export { logger, logPath };
