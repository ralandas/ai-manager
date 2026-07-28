/**
 * One-off pilot seed: create the owner account and import their Realty Calendar
 * apartments as DB cards (title, price, rc_apartment_id). Idempotent — skips an
 * apartment card that already exists for this owner+rc id.
 *
 * Env required: PILOT_EMAIL, PILOT_PASSWORD (owner login), plus the usual RC_*.
 * Run: npx tsx src/scripts/seed-pilot.ts
 */
import { sql } from '../db/index.js';
import { register } from '../auth/auth.js';
import { RealtyCalendarClient } from '../pms/realtycalendar.js';
import { logger } from '../logger.js';

async function main() {
  const email = process.env.PILOT_EMAIL;
  const password = process.env.PILOT_PASSWORD;
  if (!email || !password) throw new Error('PILOT_EMAIL and PILOT_PASSWORD required');

  // Find or create the owner.
  let owner = (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} LIMIT 1`)[0];
  if (!owner) {
    const { user } = await register({ email, password, name: 'Пилот' });
    owner = { id: user.id };
    logger.info({ id: owner.id }, 'pilot owner created');
  } else {
    logger.info({ id: owner.id }, 'pilot owner exists');
  }

  // Pull apartments from RC.
  const rc = new RealtyCalendarClient();
  const props = await rc.listProperties();
  logger.info({ count: props.length }, 'RC apartments fetched');

  let created = 0;
  for (const p of props) {
    const exists = await sql`
      SELECT 1 FROM apartments WHERE owner_id = ${owner.id} AND rc_apartment_id = ${p.id} LIMIT 1`;
    if (exists.length) continue;
    await sql`
      INSERT INTO apartments (owner_id, title, price, rc_apartment_id)
      VALUES (${owner.id}, ${p.title}, ${p.basePrice}, ${p.id})`;
    created++;
  }
  logger.info({ created }, 'pilot apartments imported');

  const total = await sql`SELECT count(*)::int AS n FROM apartments WHERE owner_id = ${owner.id}`;
  console.log(JSON.stringify({ ownerId: owner.id, apartments: (total[0] as { n: number }).n }));
  await sql.end();
}

main().catch((e) => {
  logger.error({ err: e }, 'seed-pilot failed');
  process.exit(1);
});
