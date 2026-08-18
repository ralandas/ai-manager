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

  let c: Record<string, unknown> = {};
  if (typeof row.pms_credentials === 'string') {
    try {
      c = JSON.parse(row.pms_credentials);
    } catch {
      c = {};
    }
  } else if (row.pms_credentials && typeof row.pms_credentials === 'object') {
    c = row.pms_credentials as Record<string, unknown>;
  }

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
        username: c.username ? String(c.username) : undefined,
        password: c.password ? String(c.password) : undefined,
        sid: c.sid ? String(c.sid) : undefined,
        baseUrl: c.baseUrl ? String(c.baseUrl) : undefined,
        userAgent: c.userAgent ? String(c.userAgent) : undefined,
        arrivalTime: c.arrivalTime ? String(c.arrivalTime) : undefined,
        departureTime: c.departureTime ? String(c.departureTime) : undefined,
        planId: c.planId ? String(c.planId) : undefined,
        marketingSourceId: c.marketingSourceId ? String(c.marketingSourceId) : undefined,
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
