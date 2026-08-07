import { config } from './config.js';
import { logger } from './logger.js';
import type { Messenger } from './messenger/types.js';
import type { PmsConnector } from './pms/types.js';
import { allBookingContacts, markPaidNotified, patchBookingContact } from './store/booking-contacts.js';

const MIN = 60 * 1000;

/**
 * Background booking-payment lifecycle.
 *
 * Bnovo sends no webhook when a guest pays, so we poll each recent unpaid
 * booking's invoice (pms.isBookingPaid). Per booking, once per tick:
 *   - paid            -> confirm to the guest (once), stop watching
 *   - unpaid, >remind -> nudge the guest once ("оплатили?")
 *   - unpaid, >cancel -> tell the guest we're cancelling, then cancelBooking
 * Everything is persisted (paidNotified / paymentReminded / cancelled) so a
 * restart never double-messages or double-cancels.
 */
export function startPaymentWatcher(deps: {
  pms: PmsConnector;
  messenger: Messenger;
  intervalMs?: number;
}): void {
  const { pms, messenger } = deps;
  if (!pms.isBookingPaid) {
    logger.info('payment-watcher: PMS has no isBookingPaid — watcher disabled');
    return;
  }
  const intervalMs = deps.intervalMs ?? 60_000; // check every minute
  const remindMs = config.PAYMENT_REMIND_MS ?? 15 * MIN;
  const cancelMs = config.PAYMENT_CANCEL_MS ?? 30 * MIN;

  const firstName = (full?: string) => full?.split(/\s+/).slice(1).join(' ') || full || '';

  const tick = async () => {
    const now = Date.now();
    // Watch unpaid, not-yet-cancelled bookings created within the cancel window
    // (+a grace hour so the final cancel/notice still fires).
    const watch = allBookingContacts().filter(
      (c) => !c.paidNotified && !c.cancelled && c.createdAt && now - c.createdAt < cancelMs + 60 * MIN,
    );
    for (const c of watch) {
      const age = now - (c.createdAt ?? now);
      try {
        // 1) Paid? confirm and stop.
        if (await pms.isBookingPaid!(c.bookingId)) {
          const n = firstName(c.guestName);
          await messenger.sendMessage(c.chatId, `${n ? n + ', о' : 'О'}плату вижу — спасибо 👍 Бронь подтверждена.`);
          markPaidNotified(c.bookingId);
          logger.info({ bookingId: c.bookingId }, 'payment-watcher: paid, guest notified');
          continue;
        }

        // 2) Past the cancel deadline and still unpaid -> notify + cancel.
        if (age >= cancelMs) {
          // Mark cancelled FIRST so a slow cancel/send can't let the next tick
          // fire this branch again (which would double-message and double-cancel).
          patchBookingContact(c.bookingId, { cancelled: true });
          await messenger.sendMessage(
            c.chatId,
            'Оплата не поступила, поэтому снимаю бронь, чтобы не держать даты. ' +
              'Если ещё актуально — напишите, оформлю заново.',
          );
          if (pms.cancelBooking) {
            const ok = await pms.cancelBooking(c.bookingId).catch(() => false);
            logger.info({ bookingId: c.bookingId, ok }, 'payment-watcher: unpaid, cancelled');
          }
          continue;
        }

        // 3) Past the reminder mark (but before cancel) -> nudge once.
        if (age >= remindMs && !c.paymentReminded) {
          patchBookingContact(c.bookingId, { paymentReminded: true }); // set first (dedupe)
          const phone = config.MANAGER_PHONE ? ` Если есть вопросы — звоните менеджеру: ${config.MANAGER_PHONE}.` : '';
          await messenger.sendMessage(
            c.chatId,
            'Напоминаю про оплату брони — если не оплатить, бронь скоро снимется автоматически, чтобы не держать даты.' + phone,
          );
          logger.info({ bookingId: c.bookingId }, 'payment-watcher: reminder sent');
        }
      } catch (err) {
        logger.warn({ err, bookingId: c.bookingId }, 'payment-watcher: tick step failed');
      }
    }
  };

  // Self-scheduling loop (not setInterval): the next tick starts only after the
  // previous one finishes, so a slow cancel/send can't let overlapping ticks
  // re-enter the same booking's cancel branch before its state is persisted.
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'payment-watcher: tick failed');
    }
    setTimeout(loop, intervalMs);
  };
  setTimeout(loop, intervalMs);
  logger.info({ intervalMs, remindMs, cancelMs }, 'payment-watcher: started');
}
