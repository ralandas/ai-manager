import type { FastifyInstance } from 'fastify';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { sql } from '../db/index.js';
import { authUser } from '../auth/auth.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Telegram account connection API.
 *
 * Client never sees API ID / Hash / Session String.
 * Wizard: phone → SMS/app code → optional 2FA password.
 *
 *  POST /api/v2/telegram/login/start     { phone }
 *  POST /api/v2/telegram/login/confirm   { code, password? }
 *  POST /api/v2/telegram/login/resend
 *  POST /api/v2/telegram/login/cancel
 *  GET  /api/v2/telegram/status
 *  DELETE /api/v2/telegram/disconnect
 */

const LOGIN_TTL_MS = 10 * 60 * 1000;
const DEVICE = {
  deviceModel: 'Desktop',
  systemVersion: 'Windows 10',
  appVersion: '6.9.3',
} as const;

interface PendingLogin {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  viaApp: boolean;
  needPassword: boolean;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingLogin>();

export function registerTelegramConnectApi(app: FastifyInstance): void {
  app.post<{ Body: { phone?: string } }>('/api/v2/telegram/login/start', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const keys = platformKeys();
    if (!keys) {
      return reply.code(503).send({
        error: 'Сервер ещё не настроен для входа в Telegram. Напишите нам.',
      });
    }

    const phone = normalizePhone(req.body?.phone ?? '');
    if (!phone) {
      return reply.code(400).send({ error: 'Укажите номер телефона, например +7 914 000-00-00' });
    }

    await dropPending(uid);

    const client = new TelegramClient(new StringSession(''), keys.apiId, keys.apiHash, {
      connectionRetries: 5,
      requestRetries: 2,
      autoReconnect: false,
      ...DEVICE,
    });

    try {
      await withTimeout(client.connect(), 30_000, 'connect');
      const sent = await client.sendCode({ apiId: keys.apiId, apiHash: keys.apiHash }, phone);
      storePending(uid, {
        client,
        phone,
        phoneCodeHash: sent.phoneCodeHash,
        viaApp: sent.isCodeViaApp,
        needPassword: false,
        createdAt: Date.now(),
        timer: setTimeout(() => {
          void dropPending(uid);
        }, LOGIN_TTL_MS),
      });
      logger.info({ uid, phone: maskPhone(phone), viaApp: sent.isCodeViaApp }, 'TG login: code sent');
      return {
        ok: true,
        phone_masked: maskPhone(phone),
        via_app: sent.isCodeViaApp,
      };
    } catch (err) {
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
      const mapped = mapTgError(err);
      logger.error({ uid, err }, 'TG login: sendCode failed');
      return reply.code(400).send({ error: mapped });
    }
  });

  app.post<{ Body: { code?: string; password?: string } }>(
    '/api/v2/telegram/login/confirm',
    async (req, reply) => {
      const uid = authUser(req, reply);
      if (!uid) return;

      const p = pending.get(uid);
      if (!p) {
        return reply.code(400).send({
          error: 'Сначала запросите код. Если прошло больше 10 минут — начните заново.',
        });
      }

      const password = (req.body?.password ?? '').trim();
      const code = (req.body?.code ?? '').replace(/\D/g, '');

      try {
        if (p.needPassword || password) {
          if (!password) {
            return {
              ok: false,
              need_password: true,
              hint: 'Введите облачный пароль двухэтапной проверки Telegram',
            };
          }
          await signIn2fa(p.client, password);
        } else {
          if (!code || code.length < 4) {
            return reply.code(400).send({ error: 'Введите код из Telegram или SMS' });
          }
          const signed = await signInCode(p.client, p.phone, p.phoneCodeHash, code);
          if (signed === 'password') {
            p.needPassword = true;
            return {
              ok: false,
              need_password: true,
              hint: 'У аккаунта включена двухэтапная проверка. Введите облачный пароль.',
            };
          }
          if (signed === 'signup') {
            await dropPending(uid);
            return reply.code(400).send({
              error: 'Этот номер не зарегистрирован в Telegram. Войдите с существующего аккаунта.',
            });
          }
        }

        const saved = await persistAuthorized(uid, p.client);
        await dropPending(uid);
        logger.info({ uid, username: saved.username }, 'TG login: connected');
        return { ok: true, ...saved };
      } catch (err) {
        const mapped = mapTgError(err);
        logger.error({ uid, err }, 'TG login: confirm failed');
        // Wrong code / password — keep pending so they can retry.
        const fatal =
          mapped.includes('истёк') ||
          mapped.includes('заново') ||
          mapped.includes('заблокирован');
        if (fatal) await dropPending(uid);
        return reply.code(400).send({ error: mapped });
      }
    },
  );

  app.post('/api/v2/telegram/login/resend', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    const p = pending.get(uid);
    if (!p) {
      return reply.code(400).send({ error: 'Сначала запросите код' });
    }
    try {
      const result = await p.client.invoke(
        new Api.auth.ResendCode({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash }),
      );
      if (result instanceof Api.auth.SentCodeSuccess) {
        // Already authorized somehow — treat as connected in persist path.
        const saved = await persistAuthorized(uid, p.client);
        await dropPending(uid);
        return { ok: true, already_authorized: true, ...saved };
      }
      p.phoneCodeHash = result.phoneCodeHash;
      p.viaApp = result.type instanceof Api.auth.SentCodeTypeApp;
      logger.info({ uid, viaApp: p.viaApp }, 'TG login: code resent');
      return { ok: true, via_app: p.viaApp, phone_masked: maskPhone(p.phone) };
    } catch (err) {
      const mapped = mapTgError(err);
      logger.error({ uid, err }, 'TG login: resend failed');
      return reply.code(400).send({ error: mapped });
    }
  });

  app.post('/api/v2/telegram/login/cancel', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    await dropPending(uid);
    return { ok: true };
  });

  app.get('/api/v2/telegram/status', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;

    const rows = await sql<{ tg_connected: boolean; tg_config: TgConfigShape }[]>`
      SELECT tg_connected, tg_config FROM users WHERE id = ${uid} LIMIT 1`;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'user not found' });

    const cfg = row.tg_config ?? {};
    const p = pending.get(uid);
    return {
      connected: row.tg_connected,
      username: cfg.username || null,
      first_name: cfg.first_name || null,
      phone_masked: cfg.phone ? maskPhone(cfg.phone) : null,
      has_session: !!cfg.session,
      pending: p
        ? {
            phone_masked: maskPhone(p.phone),
            via_app: p.viaApp,
            need_password: p.needPassword,
          }
        : null,
    };
  });

  app.delete('/api/v2/telegram/disconnect', async (req, reply) => {
    const uid = authUser(req, reply);
    if (!uid) return;
    await dropPending(uid);
    await sql`
      UPDATE users SET
        tg_config = '{}'::jsonb,
        tg_connected = false
      WHERE id = ${uid}`;
    logger.info({ uid }, 'Telegram disconnected');
    return { ok: true };
  });
}

// --- Login helpers ---

interface TgConfigShape {
  api_id?: number;
  api_hash?: string;
  session?: string;
  username?: string | null;
  first_name?: string | null;
  phone?: string | null;
  private_only?: boolean;
  polling?: boolean;
  poll_interval_ms?: number;
}

function platformKeys(): { apiId: number; apiHash: string } | null {
  if (!config.TG_API_ID || !config.TG_API_HASH) return null;
  return { apiId: config.TG_API_ID, apiHash: config.TG_API_HASH };
}

function storePending(uid: string, p: PendingLogin): void {
  const prev = pending.get(uid);
  if (prev) clearTimeout(prev.timer);
  pending.set(uid, p);
}

async function dropPending(uid: string): Promise<void> {
  const p = pending.get(uid);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(uid);
  try {
    await p.client.disconnect();
  } catch {
    /* ignore */
  }
}

async function signInCode(
  client: TelegramClient,
  phone: string,
  phoneCodeHash: string,
  phoneCode: string,
): Promise<'ok' | 'password' | 'signup'> {
  try {
    const result = await client.invoke(
      new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode }),
    );
    if (result instanceof Api.auth.AuthorizationSignUpRequired) return 'signup';
    return 'ok';
  } catch (err) {
    const code = rpcCode(err);
    if (code === 'SESSION_PASSWORD_NEEDED') return 'password';
    throw err;
  }
}

async function signIn2fa(client: TelegramClient, password: string): Promise<void> {
  const srp = await client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(srp, password);
  await client.invoke(new Api.auth.CheckPassword({ password: check }));
}

async function persistAuthorized(
  uid: string,
  client: TelegramClient,
): Promise<{ username: string | null; first_name: string | null; phone_masked: string | null }> {
  const keys = platformKeys();
  if (!keys) throw new Error('Сервер не настроен для Telegram');

  const me = (await client.getMe()) as Api.User;
  const session = client.session.save() as unknown as string;
  if (!session) throw new Error('Не удалось сохранить сессию Telegram');

  const username = me.username ?? null;
  const firstName = me.firstName ?? null;
  const phone = me.phone ? (me.phone.startsWith('+') ? me.phone : `+${me.phone}`) : null;

  const tgConfig: TgConfigShape = {
    api_id: keys.apiId,
    api_hash: keys.apiHash,
    session,
    username,
    first_name: firstName,
    phone,
    private_only: true,
    polling: true,
    poll_interval_ms: 4000,
  };

  await sql`
    UPDATE users SET
      tg_config = ${JSON.stringify(tgConfig)}::jsonb,
      tg_connected = true
    WHERE id = ${uid}`;

  return {
    username,
    first_name: firstName,
    phone_masked: phone ? maskPhone(phone) : null,
  };
}

function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (plus) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return `+${digits}`;
}

function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length < 4) return phone;
  const last = d.slice(-4);
  const cc = d.startsWith('7') && d.length === 11 ? '+7' : phone.startsWith('+') ? `+${d.slice(0, d.length - 10) || d.slice(0, 1)}` : '+';
  return `${cc} ••• ••• ${last.slice(0, 2)}-${last.slice(2)}`;
}

function rpcCode(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return (e.errorMessage || e.message || '').toString();
}

function mapTgError(err: unknown): string {
  const code = rpcCode(err);
  const seconds = (err as { seconds?: number }).seconds;

  if (/PHONE_NUMBER_INVALID/i.test(code)) return 'Неверный номер телефона';
  if (/PHONE_NUMBER_BANNED/i.test(code)) return 'Этот номер заблокирован в Telegram';
  if (/PHONE_NUMBER_FLOOD/i.test(code)) return 'Слишком много запросов кода. Попробуйте позже';
  if (/PHONE_CODE_INVALID/i.test(code)) return 'Неверный код. Проверьте и введите ещё раз';
  if (/PHONE_CODE_EXPIRED/i.test(code)) return 'Код истёк. Запросите новый';
  if (/PHONE_CODE_EMPTY/i.test(code)) return 'Введите код из Telegram или SMS';
  if (/PASSWORD_HASH_INVALID|PASSWORD_EMPTY/i.test(code)) return 'Неверный облачный пароль';
  if (/SESSION_PASSWORD_NEEDED/i.test(code)) return 'Нужен облачный пароль двухэтапной проверки';
  if (/AUTH_RESTART/i.test(code)) return 'Telegram просит начать вход заново';
  if (/FLOOD/i.test(code)) {
    const wait = seconds ?? Number((code.match(/(\d+)/) ?? [])[1]);
    if (wait && Number.isFinite(wait)) {
      const min = Math.ceil(wait / 60);
      return min >= 2
        ? `Слишком много попыток. Подождите ${min} мин.`
        : `Слишком много попыток. Подождите ${wait} сек.`;
    }
    return 'Слишком много попыток. Подождите немного';
  }
  if (/TIMEOUT/i.test(code)) return 'Telegram не ответил. Попробуйте ещё раз';
  if (/NETWORK|DISCONNECT|NOT_CONNECTED/i.test(code)) return 'Нет связи с Telegram. Попробуйте ещё раз';

  // Don't leak raw gramjs dumps to the cabinet.
  logger.warn({ code }, 'TG login: unmapped error');
  return 'Не удалось войти в Telegram. Проверьте номер и попробуйте снова';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT ${label} after ${ms}ms`)), ms),
    ),
  ]);
}
