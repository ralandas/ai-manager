/**
 * Live smoke test for BnovoClient. Pass SID via BNOVO_SID.
 * MODE=read (default): read-only. MODE=write: create+cancel a real test booking
 * and also cancel the leftover #99404607.
 */
import { BnovoClient } from '../pms/bnovo.js';

const sid = process.env.BNOVO_SID;
if (!sid) throw new Error('set BNOVO_SID');
const mode = process.env.MODE ?? 'read';

const c = new BnovoClient({ sid, arrivalTime: '14:00', departureTime: '12:00' });

console.log('--- listProperties ---');
const props = await c.listProperties();
console.log('rooms:', props.length, '| sample:', props.slice(0, 3).map((p) => `${p.id}:${p.title}`).join('  '));

console.log('\n--- checkAvailability 2027-06-01..2027-06-03 ---');
const av = await c.checkAvailability({ checkIn: '2027-06-01', checkOut: '2027-06-03', guests: 2 });
console.log('evaluated:', av.length, '| free:', av.filter((a) => a.available).length, '| busy:', av.filter((a) => !a.available).length);

if (mode === 'write') {
  // Uses the exact room_type/room pair proven to work in the manual /booking/add.
  const ROOM_TYPE_ID = 666444;
  const ROOM_ID = 1222930;
  console.log('\n--- createBooking (test, 2027-01-09..10) ---');
  // Temporarily craft the add via a low-level path: our createBooking maps
  // propertyId -> room_type_id/room_id, so pass a synthetic id that carries both.
  const created = await c.createBookingRaw({
    checkIn: '2027-01-09',
    checkOut: '2027-01-10',
    roomTypeId: ROOM_TYPE_ID,
    roomId: ROOM_ID,
    guests: 1,
    name: 'ТЕСТ',
    surname: 'АИМенеджер',
    phone: '+70000000000',
    price: 100,
    notes: 'ai-manager smoke test',
  });
  console.log('created booking id:', created);

  if (created) {
    console.log('--- cancel the just-created booking ---');
    const ok = await c.cancelBooking(created);
    console.log('cancel result:', ok);
  }
}

console.log('\n--- cancel leftover #99404607 ---');
const ok2 = await c.cancelBooking('99404607', { bookingNumber: '5HYA5-310726' });
console.log('cancel #99404607:', ok2);

process.exit(0);
