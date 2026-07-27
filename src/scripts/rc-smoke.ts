/**
 * Live smoke test of the RealtyCalendar READ paths against the real API.
 * Does NOT create bookings. Run with RC_* env vars set:
 *   RC_USER_TOKEN=... RC_COOKIE=... PMS_PROVIDER=realtycalendar npx tsx src/scripts/rc-smoke.ts
 */
import { RealtyCalendarClient } from '../pms/realtycalendar.js';

async function main() {
  const rc = new RealtyCalendarClient();

  console.log('=== listProperties ===');
  const props = await rc.listProperties();
  console.log(`count: ${props.length}`);
  for (const p of props.slice(0, 5)) console.log(`  ${p.id} | ${p.title} | ${p.basePrice}`);

  console.log('\n=== checkAvailability (Aug 1-5, 2 guests, all) ===');
  const avail = await rc.checkAvailability({ checkIn: '2026-08-01', checkOut: '2026-08-05', guests: 2 });
  for (const a of avail.slice(0, 6))
    console.log(`  ${a.propertyId} | ${a.title} | free=${a.available} | ${a.nights}n | ${a.totalPrice}`);
  console.log(`  ... total ${avail.length}, free: ${avail.filter((a) => a.available).length}`);

  console.log('\n=== getCheckouts (2026-08-03) ===');
  const outs = await rc.getCheckouts('2026-08-03');
  for (const c of outs) console.log(`  ${c.propertyTitle} | ${c.guestName} | ${c.checkOutDate}`);
  console.log(`  total checkouts: ${outs.length}`);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
