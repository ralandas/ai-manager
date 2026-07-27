import { config } from './config.js';
import { logger } from './logger.js';
import type { Messenger } from './messenger/types.js';
import type { PmsConnector } from './pms/types.js';
import { getBookingContact } from './store/booking-contacts.js';

/**
 * Housekeeping: every evening the agent (a) DMs each guest checking out tomorrow
 * to confirm their exact checkout time, and (b) posts the prep list — including
 * any confirmed times — to the cleaners' chat.
 */
export class Housekeeping {
  constructor(
    private readonly pms: PmsConnector,
    private readonly messenger: Messenger,
  ) {}

  /** ISO date (YYYY-MM-DD) for "tomorrow" relative to now. */
  private tomorrow(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Day-before-checkout: DM each guest checking out tomorrow, asking for their
   * exact departure time. The guest's reply is handled by the agent, which calls
   * the confirm_checkout_time tool to record it (checkout is 12:00 by default).
   */
  async remindGuestsAboutCheckout(): Promise<void> {
    const date = this.tomorrow();
    const checkouts = await this.pms.getCheckouts(date);
    for (const c of checkouts) {
      const contact = getBookingContact(c.bookingId);
      if (!contact?.chatId) {
        logger.warn({ bookingId: c.bookingId }, 'checkout reminder: no chat for booking, skipping');
        continue;
      }
      const text =
        `Здравствуйте! Напоминаем, что завтра (${date}) у вас выезд из «${c.propertyTitle}». ` +
        `Расчётный час — до 12:00. Подскажите, пожалуйста, во сколько примерно планируете выехать?`;
      await this.messenger.sendMessage(contact.chatId, text);
      logger.info({ bookingId: c.bookingId, chatId: contact.chatId }, 'checkout reminder sent');
    }
  }

  async postTomorrowForecast(): Promise<void> {
    if (!config.HOUSEKEEPING_CHAT_ID) {
      logger.warn('HOUSEKEEPING_CHAT_ID not set — skipping forecast');
      return;
    }
    const date = this.tomorrow();
    const checkouts = await this.pms.getCheckouts(date);

    if (checkouts.length === 0) {
      await this.messenger.sendMessage(
        config.HOUSEKEEPING_CHAT_ID,
        `🧹 На завтра (${date}) выездов нет.`,
      );
      return;
    }

    const lines = checkouts.map((c, i) => {
      const time = getBookingContact(c.bookingId)?.checkoutTime;
      const when = time ? `выезд ~${time}` : `выезд до 12:00 (время не уточнено)`;
      return `${i + 1}. ${c.propertyTitle} — ${when} (гость: ${c.guestName})`;
    });
    const text = `🧹 Выезды на завтра (${date}) — ${checkouts.length}:\n${lines.join('\n')}\n\nПодготовьте квартиры к уборке.`;
    await this.messenger.sendMessage(config.HOUSEKEEPING_CHAT_ID, text);
    logger.info({ date, count: checkouts.length }, 'housekeeping: forecast posted');
  }
}

/**
 * Minimal daily scheduler: fires `fn` once per day at the given local hour.
 * Avoids a cron dependency; good enough for one nightly job on the pilot.
 */
export function scheduleDaily(hour: number, fn: () => Promise<void>): void {
  const tick = () => {
    const now = new Date();
    if (now.getHours() === hour && now.getMinutes() === 0) {
      fn().catch((err) => logger.error({ err }, 'scheduled job failed'));
    }
  };
  // Check every minute; align roughly to the minute boundary.
  setInterval(tick, 60_000);
  logger.info({ hour }, 'housekeeping: daily forecast scheduled');
}
