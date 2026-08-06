import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
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
  private pollTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  /** Highest message id already dispatched per chat — dedupes poll vs events. */
  private readonly lastSeen = new Map<string, number>();

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
    const me = (await this.client.getMe()) as Api.User;
    logger.info({ user: me?.username ?? me?.id?.toString() }, 'telegram-user: connected');

    // Set the public @username. TG_USERNAME may be a comma-separated list of
    // candidates; the first free one is applied (Telegram 400s USERNAME_OCCUPIED
    // on taken ones). Skips if already set to one of them.
    if (config.TG_USERNAME) {
      const candidates = config.TG_USERNAME.split(',').map((s) => s.trim()).filter(Boolean);
      if (!candidates.includes(me?.username ?? '')) {
        for (const username of candidates) {
          try {
            await this.client.invoke(new Api.account.UpdateUsername({ username }));
            logger.info({ username }, 'telegram-user: username set');
            break;
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            logger.warn({ username, err: m }, 'telegram-user: username not available, trying next');
          }
        }
      }
    }

    this.client.addEventHandler((e) => this.onEvent(e), new NewMessage({ incoming: true }));

    // Direct-IP fallback: push updates may never arrive even though the session
    // can send and read. Poll for new incoming messages in that case.
    if (config.TG_POLLING) {
      this.polling = true;
      const interval = config.TG_POLL_INTERVAL_MS ?? 4000;
      logger.info({ interval }, 'telegram-user: polling mode enabled');
      const loop = async () => {
        if (!this.polling) return;
        try {
          await this.pollOnce();
        } catch (err) {
          logger.error({ err }, 'telegram-user: poll cycle failed');
        }
        this.pollTimer = setTimeout(loop, interval);
      };
      // Seed lastSeen with the current top ids so we don't replay the backlog
      // as if it were new; then start the loop.
      await this.seedLastSeen().catch(() => {});
      this.pollTimer = setTimeout(loop, interval);
    }
  }

  private async onEvent(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    await this.handleMessage(msg);
  }

  /** One polling pass: scan private dialogs for unread incoming, dispatch, read. */
  private async pollOnce(): Promise<void> {
    const dialogs = await this.withTimeout(this.client.getDialogs({ limit: 30 }), 30_000, 'getDialogs');
    const unread = dialogs.filter((d) => d.isUser && d.unreadCount > 0);
    if (unread.length) {
      logger.info(
        { dialogs: unread.map((d) => `${d.name}:${d.unreadCount}`) },
        'telegram-user: poll found unread',
      );
    }
    for (const d of dialogs) {
      if (!d.isUser || d.unreadCount <= 0 || !d.entity) continue;
      const entity = d.entity;
      const msgs = await this.client
        .getMessages(entity, { limit: Math.min(d.unreadCount, 20) })
        .catch(() => []);
      // Oldest-first so a burst is handled in order.
      const incoming = msgs.filter((m) => !m.out && m.message).reverse();
      for (const m of incoming) await this.handleMessage(m);
      await this.client.markAsRead(entity).catch(() => {});
    }
  }

  /** Record the newest message id per dialog so polling only reacts to newer ones. */
  private async seedLastSeen(): Promise<void> {
    const dialogs = await this.client.getDialogs({ limit: 30 }).catch(() => []);
    for (const d of dialogs) {
      const id = d.message?.id;
      const chatId = d.id?.toString();
      if (id && chatId) this.lastSeen.set(chatId, id);
    }
  }

  /** Shared dispatch for both event- and poll-sourced messages, deduped by id. */
  private async handleMessage(msg: Api.Message): Promise<void> {
    try {
      if (!msg?.message) return; // no text

      // Private, human-to-human only.
      if (config.TG_PRIVATE_ONLY) {
        if (!msg.isPrivate) return;
        const sender = await msg.getSender();
        if (sender instanceof Api.User && (sender.bot || sender.self)) return;
      }

      const chatId = msg.chatId?.toString() ?? msg.senderId?.toString();
      if (!chatId) return;

      // Dedupe: skip anything at or below the highest id already handled here.
      const seen = this.lastSeen.get(chatId) ?? 0;
      if (msg.id <= seen) return;
      this.lastSeen.set(chatId, msg.id);

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
    if (urls.length === 0) return;
    // Send as ONE album (media group). Telegram caps an album at 10 items.
    // We download each image ourselves and upload the bytes: passing bnovo URLs
    // straight to Telegram fails MEDIA_INVALID for a group (it can't fetch them
    // in time), and sending photos one-by-one tripped FloodWaitError. One album
    // = one grouped, captioned gallery per apartment, and one rate-limit unit.
    const ALBUM_MAX = 10;
    const batch = urls.slice(0, ALBUM_MAX);
    try {
      const files = await Promise.all(
        batch.map(async (url, i) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          return new CustomFile(`photo_${i}.jpg`, buf.length, '', buf);
        }),
      );
      await this.withTimeout(
        this.client.sendFile(chatId, { file: files, caption }),
        120_000,
        'sendAlbum',
      );
    } catch (err) {
      logger.error({ chatId, count: batch.length, err }, 'telegram-user: sendPhotos album failed');
    }
  }

  /** Stop polling and release the session lock (graceful shutdown). */
  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try {
      await this.client?.disconnect();
    } catch {
      /* ignore */
    }
    this.lock.release();
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
