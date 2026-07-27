import { config } from '../config.js';
import { logger } from '../logger.js';
import { StubPms } from './stub.js';
import { RealtyCalendarClient } from './realtycalendar.js';
import type { PmsConnector } from './types.js';

export function createPms(): PmsConnector {
  switch (config.PMS_PROVIDER) {
    case 'realtycalendar':
      logger.info('PMS: using Realty Calendar');
      return new RealtyCalendarClient();
    case 'stub':
    default:
      logger.info('PMS: using in-memory stub');
      return new StubPms();
  }
}

export type { PmsConnector } from './types.js';
