import { config } from '../config.js';
import { logger } from '../logger.js';
import { StubPms } from './stub.js';
import type { PmsConnector } from './types.js';

export function createPms(): PmsConnector {
  switch (config.PMS_PROVIDER) {
    case 'realtycalendar':
      // TODO: implement after reverse-engineering the Realty Calendar web client.
      logger.warn('realtycalendar connector not implemented yet — falling back to stub');
      return new StubPms();
    case 'stub':
    default:
      logger.info('PMS: using in-memory stub');
      return new StubPms();
  }
}

export type { PmsConnector } from './types.js';
