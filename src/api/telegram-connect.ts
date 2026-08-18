import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { authUser } from '../auth/auth.js';
import { logger } from '../logger.js';

/**
 * Telegram account connection API:
 *  - POST   /api/v2/telegram/connect     — save TG config
 *  - POST   /api/v2/telegram/test        — verify session is authorized
 *  - GET    /api/v2/telegram/status       — connection status
 *  - DELETE /api/v2/telegram/disconnect   — clear TG config
 *
 * The session string is stored in users.tg_config (JSONB). On connect, the
 * server verifies the session by creating a temporary TelegramClient, connecting,
 * checking isUserAuthorized(), and immediately disconnecting.
 */
export function registerTelegramConnectApi(app: FastifyInstance): void {
  // --- Connect ---
  app.post<{
    Body: {
      apiId: number;
      apiHash: string;
      session: string;
      proxy?: string;
      username?: string;
      privateOnly?: boolean;
      polling?: boolean;
      pollIntervalMs?: number;
    };
  }>('/api/v2/telegram/connect', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const b = req.body ?? {};
    if (!b.apiId || !b.apiHash || !b.session) {
      return reply.code(400).send({ error: 'apiId, apiHash, and session are required' });
    }

    const tgConfig = {
      api_id: b.apiId,
      api_hash: b.apiHash,
      session: b.session,
      proxy: b.proxy || null,
      username: b.username || null,
      private_only: b.privateOnly ?? true,
      polling: b.polling ?? true,
      poll_interval_ms: b.pollIntervalMs ?? 4000,
    };

    // Try to verify the session before saving.
    try {
      const ok = await testTelegramSession(tgConfig);
      if (!ok) {
        return reply.code(400).send({ error: 'Telegram session is not authorized (dead or invalid session)' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Telegram connection test failed';
      logger.error({ uid, err }, 'TG connect: test failed');
      return reply.code(400).send({ error: msg });
    }

    await sql`
      UPDATE users SET
        tg_config = ${JSON.stringify(tgConfig)}::jsonb,
        tg_connected = true
      WHERE id = ${uid}`;

    logger.info({ uid, username: b.username }, 'Telegram connected');
    return { ok: true, username: b.username || null };
  });

  // --- Test (with provided or stored config) ---
  app.post<{
    Body?: {
      apiId?: number;
      apiHash?: string;
      session?: string;
      proxy?: string;
    };
  }>('/api/v2/telegram/test', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const b = req.body ?? {};
    let tgConfig: TgConfigShape;

    if (b.apiId && b.apiHash && b.session) {
      // Test with provided creds (before saving).
      tgConfig = {
        api_id: b.apiId,
        api_hash: b.apiHash,
        session: b.session,
        proxy: b.proxy || null,
      };
    } else {
      // Test with stored creds.
      const rows = await sql<{ tg_config: TgConfigShape }[]>`
        SELECT tg_config FROM users WHERE id = ${uid} LIMIT 1`;
      if (!rows[0]?.tg_config?.api_id) {
        return reply.code(400).send({ error: 'No Telegram config found — provide apiId, apiHash, session' });
      }
      tgConfig = rows[0].tg_config;
    }

    try {
      const ok = await testTelegramSession(tgConfig);
      return { ok, authorized: ok };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Test failed';
      return reply.code(400).send({ error: msg });
    }
  });

  // --- Status ---
  app.get('/api/v2/telegram/status', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const rows = await sql<{
      tg_connected: boolean;
      tg_config: TgConfigShape;
    }[]>`
      SELECT tg_connected, tg_config FROM users WHERE id = ${uid} LIMIT 1`;

    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'user not found' });

    const cfg = row.tg_config ?? {};
    return {
      connected: row.tg_connected,
      username: cfg.username || null,
      has_session: !!cfg.session,
      has_proxy: !!cfg.proxy,
      polling: cfg.polling ?? false,
    };
  });

  // --- Disconnect ---
  app.delete('/api/v2/telegram/disconnect', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    await sql`
      UPDATE users SET
        tg_config = '{}'::jsonb,
        tg_connected = false
      WHERE id = ${uid}`;

    logger.info({ uid }, 'Telegram disconnected');
    return { ok: true };
  });
}

// --- Helpers ---

interface TgConfigShape {
  api_id?: number;
  api_hash?: string;
  session?: string;
  proxy?: string | null;
  username?: string | null;
  private_only?: boolean;
  polling?: boolean;
  poll_interval_ms?: number;
}

/**
 * Create a temporary TelegramClient, connect, check isUserAuthorized, disconnect.
 * Returns true if the session is valid and authorized.
 */
async function testTelegramSession(cfg: TgConfigShape): Promise<boolean> {
  // Dynamic import — gramjs is heavy and may not be needed on every request.
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');

  if (!cfg.api_id || !cfg.api_hash || !cfg.session) {
    throw new Error('api_id, api_hash, and session are required');
  }

  let proxy: { ip: string; port: number; socksType: 5; username?: string; password?: string; timeout: number } | undefined;
  if (cfg.proxy) {
    try {
      const u = new URL(cfg.proxy);
      proxy = {
        ip: u.hostname,
        port: Number(u.port),
        socksType: 5,
        username: decodeURIComponent(u.username) || undefined,
        password: decodeURIComponent(u.password) || undefined,
        timeout: 15,
      };
    } catch {
      // Bad proxy URL — ignore.
    }
  }

  const client = new TelegramClient(
    new StringSession(cfg.session),
    cfg.api_id,
    cfg.api_hash,
    {
      connectionRetries: 3,
      requestRetries: 2,
      autoReconnect: false,
      deviceModel: 'Desktop',
      systemVersion: 'Windows 10',
      appVersion: '6.9.3',
      ...(proxy ? { proxy } : {}),
    },
  );

  try {
    // Timeout: 20s for connect.
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout (20s)')), 20_000)),
    ]);

    const authorized = await client.isUserAuthorized();
    return authorized;
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
}
