import { logger } from './logger.js';
import type { Messenger } from './messenger/types.js';
import type { PmsConnector } from './pms/types.js';
import { allBookingContacts, markPaidNotified } from './store/booking-contacts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Background payment watcher.
 *
 * Bnovo sends us no webhook when a guest pays, so we poll: every interval we
 * check each recent, not-yet-notified booking's invoice via pms.isBookingPaid.
 * The first time one flips to paid we DM the guest a confirmation and mark it
 * notified (persisted) so we never message twice. Bookings older than the
 * window are dropped from polling — an unpaid link that old is stale anyway.
 */
export function startPaymentWatcher(deps: {
  pms: PmsConnector;
  messenger: Messenger;
  intervalMs?: number;
  windowMs?: number;
}): void {
  const { pms, messenger } = deps;
  if (!pms.isBookingPaid) {
    logger.info('payment-watcher: PMS has no isBookingPaid — watcher disabled');
    return;
  }
  const intervalMs = deps.intervalMs ?? 60_000; // check every minute
  const windowMs = deps.windowMs ?? 2 * DAY_MS; // stop watching after 2 days

  const tick = async () => {
    // createdAt is required to bound the window; skip legacy rows without it.
    const now = Date.now();
    const watch = allBookingContacts().filter(
      (c) => !c.paidNotified && c.createdAt && now - c.createdAt < windowMs,
    );
    for (const c of watch) {
      try {
        const paid = await pms.isBookingPaid!(c.bookingId);
        if (!paid) continue;
        const name = c.guestName?.split(/\s+/).slice(1).join(' ') || c.guestName || '';
        await messenger.sendMessage(
          c.chatId,
          `${name ? name + ', о' : 'О'}плату вижу — спасибо 👍 Бронь подтверждена.`,
        );
        markPaidNotified(c.bookingId);
        logger.info({ bookingId: c.bookingId, chatId: c.chatId }, 'payment-watcher: payment detected, guest notified');
      } catch (err) {
        logger.warn({ err, bookingId: c.bookingId }, 'payment-watcher: check failed');
      }
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'payment-watcher: tick failed'));
  }, intervalMs);
  logger.info({ intervalMs, windowMs }, 'payment-watcher: started');
}
