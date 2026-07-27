import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { IncomingMessage, Messenger, MessageHandler } from './types.js';

/**
 * Telegram Bot API connector.
 * Inbound: Telegram POSTs updates to /webhook/telegram/:secret.
 * Outbound: calls the Bot API sendMessage endpoint.
 */
export class TelegramMessenger implements Messenger {
  readonly name = 'telegram' as const;
  private readonly api: string;

  constructor(
    private readonly app: FastifyInstance,
    private readonly onMessage: MessageHandler,
  ) {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required for the telegram messenger');
    }
    this.api = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
  }

  async init(): Promise<void> {
    if (config.TELEGRAM_MODE === 'polling') {
      await this.initPolling();
    } else {
      await this.initWebhook();
    }
  }

  /**
   * Long-polling mode: no public HTTPS needed. We ask Telegram to drop any
   * existing webhook, then loop getUpdates. Good for the pilot / dev.
   */
  private async initPolling(): Promise<void> {
    await fetch(`${this.api}/deleteWebhook`, { method: 'POST' }).catch(() => {});
    logger.info('telegram: polling mode (getUpdates)');
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(`${this.api}/getUpdates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offset, timeout: 30, allowed_updates: ['message'] }),
        });
        const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        for (const update of data.result ?? []) {
          offset = update.update_id + 1;
          try {
            const msg = this.normalize(update);
            if (msg) await this.onMessage(msg);
          } catch (err) {
            logger.error({ err }, 'telegram: failed to handle polled update');
          }
        }
      } catch (err) {
        logger.error({ err }, 'telegram: getUpdates failed, retrying in 3s');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async initWebhook(): Promise<void> {
    const path = `/webhook/telegram/${config.TELEGRAM_WEBHOOK_SECRET}`;

    this.app.post(path, async (req, reply) => {
      // Reply 200 immediately; process async so Telegram doesn't retry on slow LLM.
      reply.send({ ok: true });
      try {
        const msg = this.normalize(req.body as TelegramUpdate);
        if (msg) await this.onMessage(msg);
      } catch (err) {
        logger.error({ err }, 'telegram: failed to handle update');
      }
    });

    if (config.PUBLIC_URL) {
      const url = `${config.PUBLIC_URL}${path}`;
      const res = await fetch(`${this.api}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, allowed_updates: ['message'] }),
      });
      const body = await res.json();
      logger.info({ url, body }, 'telegram: setWebhook');
    } else {
      logger.warn('PUBLIC_URL not set — skipping setWebhook (use a tunnel for local dev)');
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.api}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error({ chatId, status: res.status, body }, 'telegram: sendMessage failed');
    }
  }

  private normalize(update: TelegramUpdate): IncomingMessage | null {
    const m = update.message;
    if (!m || typeof m.text !== 'string') return null;
    return {
      chatId: String(m.chat.id),
      senderName: m.from?.first_name,
      text: m.text,
      providerMessageId: String(m.message_id),
      timestamp: m.date,
    };
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number };
    from?: { first_name?: string };
  };
}
