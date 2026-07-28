import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from './index.js';
import { logger } from '../logger.js';

/**
 * Applies schema.sql (idempotent — all statements use IF NOT EXISTS).
 * Run: npm run migrate
 */
async function main() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const ddl = readFileSync(join(dir, 'schema.sql'), 'utf8');
  await sql.unsafe(ddl);
  logger.info('migration applied');
  await sql.end();
}

main().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
