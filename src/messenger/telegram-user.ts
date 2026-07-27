import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { IncomingMessage, Messenger, MessageHandler } from './types.js';
import { SessionLock } from './session-lock.js';

/**
 * Personal Telegram account connector via gramjs (MTProto), per the Lead Zavod
 * account schema. NOT a bot — messages come from a real user account.
 *
 * Safety rules baked in (from the schema's hard lessons):
 *  - one session = one process, enforced by SessionLock (AUTH_KEY_DUPLICATED kills accounts)
 *  - stable device fingerprint (sudden "device" change is a flag)
 *  - per-account SOCKS geo-proxy
 *  - withTimeout on network calls so a stuck proxy connect can't hang the loop
 *  - private chats with real humans only (never groups/channels/bots)
 */
export class TelegramUserMessenger implements Messenger {
  readonly name = 'telegram' as const;
  private client!: TelegramClient;
  private readonly lock: SessionLock;

  constructor(private readonly onMessage: MessageHandler) {
    if (!config.TG_API_ID || !config.TG_API_HASH || !config.TG_SESSION) {
      throw new Error('TG_API_ID, TG_API_HASH and TG_SESSION are required for telegram-user');
    }
    this.lock = new SessionLock(config.TG_SESSION);
  }

  async init(): Promise<void> {
    // Refuse to start if another process already holds this session.
    this.lock.acquire();

    const proxy = this.parseProxy(config.TG_PROXY);
    this.client = new TelegramClient(
      new StringSession(config.TG_SESSION!),
      config.TG_API_ID!,
      config.TG_API_HASH!,
      {
        connectionRetries: 10,
        requestRetries: 5,
        autoReconnect: true,
        floodSleepThreshold: 60,
        // Stable fingerprint — keep constant across restarts.
        deviceModel: 'Desktop',
        systemVersion: 'Windows 10',
        appVersion: '6.9.3',
        ...(proxy ? { proxy } : {}),
      },
    );

    await this.withTimeout(this.client.connect(), 30_000, 'connect');
    if (!(await this.client.isUserAuthorized())) {
      this.lock.release();
      throw new Error('Telegram session is not authorized (dead session — needs re-login)');
    }
    const me = await this.client.getMe();
    logger.info(
      { user: (me as Api.User)?.username ?? (me as Api.User)?.id?.toString() },
      'telegram-user: connected',
    );

    this.client.addEventHandler((e) => this.onEvent(e), new NewMessage({ incoming: true }));
  }

  private async onEvent(event: NewMessageEvent): Promise<void> {
    try {
      const msg = event.message;
      if (!msg?.message) return; // no text

      // Private, human-to-human only.
      if (config.TG_PRIVATE_ONLY) {
        if (!msg.isPrivate) return;
        const sender = await msg.getSender();
        if (sender instanceof Api.User && (sender.bot || sender.self)) return;
      }

      const chatId = msg.chatId?.toString() ?? msg.senderId?.toString();
      if (!chatId) return;

      const sender = await msg.getSender().catch(() => null);
      const senderName = sender instanceof Api.User ? sender.firstName ?? undefined : undefined;

      const incoming: IncomingMessage = {
        chatId,
        senderName,
        text: msg.message,
        providerMessageId: String(msg.id),
        timestamp: msg.date ?? Math.floor(Date.now() / 1000),
      };
      await this.onMessage(incoming);
    } catch (err) {
      logger.error({ err }, 'telegram-user: failed to handle message');
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.withTimeout(
        this.client.sendMessage(chatId, { message: text }),
        30_000,
        'sendMessage',
      );
    } catch (err) {
      logger.error({ chatId, err }, 'telegram-user: sendMessage failed');
    }
  }

  async sendPhotos(chatId: string, urls: string[], caption?: string): Promise<void> {
    // gramjs downloads the URL and uploads it as a photo. Caption on the first.
    for (let i = 0; i < urls.length; i++) {
      try {
        await this.withTimeout(
          this.client.sendFile(chatId, {
            file: urls[i]!,
            caption: i === 0 ? caption : undefined,
          }),
          60_000,
          'sendFile',
        );
      } catch (err) {
        logger.error({ chatId, url: urls[i], err }, 'telegram-user: sendFile failed');
      }
    }
  }

  private parseProxy(url?: string):
    | { ip: string; port: number; socksType: 5; username?: string; password?: string; timeout: number }
    | undefined {
    if (!url) return undefined;
    try {
      const u = new URL(url); // socks5://user:pass@host:port
      return {
        ip: u.hostname,
        port: Number(u.port),
        socksType: 5,
        username: decodeURIComponent(u.username) || undefined,
        password: decodeURIComponent(u.password) || undefined,
        timeout: 15,
      };
    } catch {
      logger.error({ url }, 'telegram-user: bad TG_PROXY url, ignoring');
      return undefined;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`TIMEOUT ${label} after ${ms}ms`)), ms),
      ),
    ]);
  }
}
