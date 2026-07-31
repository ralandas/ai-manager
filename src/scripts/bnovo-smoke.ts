/** Live read smoke test for BnovoClient via auto-login. Pass BNOVO_USER / BNOVO_PASS. */
import { BnovoClient } from '../pms/bnovo.js';

const username = process.env.BNOVO_USER;
const password = process.env.BNOVO_PASS;
if (!username || !password) throw new Error('set BNOVO_USER and BNOVO_PASS');

const c = new BnovoClient({ username, password, arrivalTime: '14:00', departureTime: '12:00' });

const props = await c.listProperties();
console.log('rooms:', props.length);

const av = await c.checkAvailability({ checkIn: '2027-06-01', checkOut: '2027-06-03', guests: 2 });
console.log('availability evaluated:', av.length, '| free:', av.filter((a) => a.available).length);

const co = await c.getCheckouts('2026-07-29');
console.log('checkouts 2026-07-29:', co.length);
process.exit(0);
