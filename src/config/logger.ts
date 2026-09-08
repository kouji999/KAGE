import pino from 'pino';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './index.js';

mkdirSync(config.dataDir, { recursive: true });
const logFile = path.join(config.dataDir, 'kage.log');

export const logger = pino({
  level: config.logLevel,
  base: undefined, // no pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      ...(process.env.NODE_ENV !== 'production'
        ? [
            {
              target: 'pino-pretty',
              level: config.logLevel,
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          ]
        : [
            {
              target: 'pino/file',
              level: config.logLevel,
              options: { destination: 1 }, // stdout plain JSON
            },
          ]),
      // file sink SELALU aktif — observability tanpa bergantung ke window console
      {
        target: 'pino/file',
        level: 'debug',
        options: { destination: logFile, mkdir: true },
      },
    ],
  },
});

export function childLogger(module: string) {
  return logger.child({ module });
}

export { logFile };
