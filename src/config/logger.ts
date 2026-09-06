import pino from 'pino';
import { config } from './index.js';

export const logger = pino({
  level: config.logLevel,
  base: undefined, // no pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});

export function childLogger(module: string) {
  return logger.child({ module });
}
