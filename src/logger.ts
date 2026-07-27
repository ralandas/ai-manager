import pino from 'pino';
import { config } from './config.js';

// Production: line-delimited JSON to an app.log we can tail (sync so nothing is
// lost on restart). Dev: pretty-print to stdout.
export const logger =
  process.env.NODE_ENV === 'production'
    ? pino(
        { level: config.LOG_LEVEL },
        pino.destination({ dest: '/opt/ai-manager/logs/app.log', sync: true }),
      )
    : pino({
        level: config.LOG_LEVEL,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      });

logger.info({ env: process.env.NODE_ENV ?? 'dev' }, 'logger initialized');
