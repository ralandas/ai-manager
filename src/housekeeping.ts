import { config } from './config.js';
import { logger } from './logger.js';
import type { Messenger } from './messenger/types.js';
import type { PmsConnector } from './pms/types.js';

/**
 * Housekeeping: every evening, forecast tomorrow's checkouts and post a
 * prep list to the cleaners' chat. (Per-booking checkout confirmation dialog
 * will be added once the messenger flow for guests is stable.)
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

    const lines = checkouts.map(
      (c, i) => `${i + 1}. ${c.propertyTitle} — выезд ${c.checkOutDate} (гость: ${c.guestName})`,
    );
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
