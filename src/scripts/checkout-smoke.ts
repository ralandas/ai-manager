/**
 * Smoke test for the checkout-reminder + forecast flow on the stub PMS.
 * Creates a booking checking out "tomorrow", then runs the reminder and the
 * cleaners forecast, printing what would be sent. No real messenger.
 */
import { StubPms } from '../pms/stub.js';
import { Housekeeping } from '../housekeeping.js';
import type { Messenger } from '../messenger/types.js';
import { rememberBookingContact, setCheckoutTime } from '../store/booking-contacts.js';

const sent: string[] = [];
const fake: Messenger = {
  name: 'telegram',
  async init() {},
  async sendMessage(chatId, text) {
    sent.push(`[to ${chatId}] ${text}`);
  },
};

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  process.env.HOUSEKEEPING_CHAT_ID = 'cleaners-chat';
  const pms = new StubPms();
  const t = tomorrow();

  const booking = await pms.createBooking({
    propertyId: 'apt-1',
    checkIn: new Date().toISOString().slice(0, 10),
    checkOut: t,
    guests: 2,
    guestName: 'Тестовый Гость',
    totalPrice: 30000,
    idempotencyKey: 'smoke-1',
  });
  rememberBookingContact({
    bookingId: booking.id,
    chatId: 'guest-777',
    guestName: booking.guestName,
    propertyId: booking.propertyId,
    checkOut: booking.checkOut,
  });

  const hk = new Housekeeping(pms, fake);

  console.log('=== 1) checkout reminder DM ===');
  await hk.remindGuestsAboutCheckout();
  sent.forEach((s) => console.log(s));
  sent.length = 0;

  console.log('\n=== 2) guest confirmed 11:30 -> forecast ===');
  setCheckoutTime(booking.id, '11:30');
  await hk.postTomorrowForecast();
  sent.forEach((s) => console.log(s));
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
