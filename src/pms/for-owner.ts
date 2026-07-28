import { sql } from '../db/index.js';
import { logger } from '../logger.js';
import { StubPms } from './stub.js';
import { RealtyCalendarClient, type RcCreds } from './realtycalendar.js';
import { BnovoClient, type BnovoCreds } from './bnovo.js';
import type { PmsConnector } from './types.js';

/**
 * Builds the PMS connector for a specific owner from their stored provider +
 * credentials. Different owners can run different PMS at the same time.
 * Cached per owner so we don't rebuild (and re-auth) on every message.
 */
const cache = new Map<string, PmsConnector>();

interface OwnerPmsRow {
  pms_provider: string;
  pms_credentials: Record<string, unknown>;
}

export async function createPmsForOwner(ownerId: string): Promise<PmsConnector> {
  const cached = cache.get(ownerId);
  if (cached) return cached;

  const rows = await sql<OwnerPmsRow[]>`
    SELECT pms_provider, pms_credentials FROM users WHERE id = ${ownerId} LIMIT 1`;
  const row = rows[0];
  if (!row) {
    logger.warn({ ownerId }, 'owner not found for PMS — using stub');
    return new StubPms();
  }

  const c = row.pms_credentials ?? {};
  let pms: PmsConnector;
  switch (row.pms_provider) {
    case 'realtycalendar':
      pms = new RealtyCalendarClient({
        userToken: String(c.userToken ?? ''),
        cookie: c.cookie ? String(c.cookie) : undefined,
        userAgent: c.userAgent ? String(c.userAgent) : undefined,
        baseUrl: c.baseUrl ? String(c.baseUrl) : undefined,
        defaultDeposit: c.defaultDeposit ? Number(c.defaultDeposit) : undefined,
      } satisfies RcCreds);
      break;
    case 'bnovo':
      pms = new BnovoClient({
        accountId: String(c.accountId ?? ''),
        password: String(c.password ?? ''),
        baseUrl: c.baseUrl ? String(c.baseUrl) : undefined,
        cookie: c.cookie ? String(c.cookie) : undefined,
        userAgent: c.userAgent ? String(c.userAgent) : undefined,
      } satisfies BnovoCreds);
      break;
    default:
      pms = new StubPms();
  }

  logger.info({ ownerId, provider: row.pms_provider }, 'PMS built for owner');
  cache.set(ownerId, pms);
  return pms;
}

/** Drop a cached connector (e.g. after the owner updates credentials). */
export function invalidateOwnerPms(ownerId: string): void {
  cache.delete(ownerId);
}
