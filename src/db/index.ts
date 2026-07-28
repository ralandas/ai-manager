import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Postgres client (single pool). DATABASE_URL is required for the multi-user
 * features (auth + apartments CRUD).
 */
if (!config.DATABASE_URL) {
  logger.warn('DATABASE_URL not set — DB features (auth, apartments) will fail');
}

export const sql = postgres(config.DATABASE_URL ?? '', {
  max: 10,
  idle_timeout: 30,
  onnotice: () => {}, // silence NOTICE spam
});

export async function pingDb(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, 'DB ping failed');
    return false;
  }
}
