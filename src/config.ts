import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default('info'),

  LLM_PROVIDER: z.enum(['gemini', 'wavespeed']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-latest'),
  // Optional base URL override — point at the local gemini-proxy (:9090) when
  // Google's API is geo-blocked from the server. Empty = call Google directly.
  GEMINI_BASE_URL: z.string().optional(),
  // WaveSpeed LLM (OpenAI-compatible chat completions with tool calling).
  WAVESPEED_API_KEY: z.string().optional(),
  WAVESPEED_MODEL: z.string().default('deepseek/deepseek-v4-flash'),
  WAVESPEED_BASE_URL: z.string().default('https://llm.wavespeed.ai/v1'),

  MESSENGER: z.enum(['telegram', 'telegram-user', 'max']).default('telegram'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().default('change-me'),

  // Personal Telegram account (gramjs / MTProto). One session = one process.
  TG_API_ID: z.coerce.number().optional(),
  TG_API_HASH: z.string().optional(),
  TG_SESSION: z.string().optional(), // StringSession (SECRET)
  TG_PROXY: z.string().optional(), // socks5://user:pass@host:port (per-account geo proxy)
  TG_USERNAME: z.string().optional(), // desired public @username for the account
  // Only auto-reply in private chats to real users (never groups/channels/bots).
  TG_PRIVATE_ONLY: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
  // Poll for new messages instead of relying on push updates. Needed when the
  // account runs without its geo-proxy (direct IP): MTProto send/read still work
  // but the update stream stays silent, so incoming messages must be polled.
  TG_POLLING: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  TG_POLL_INTERVAL_MS: z.coerce.number().optional(), // default 4000

  // Manager phone the bot can hand out (e.g. with the payment link). Empty = omit.
  MANAGER_PHONE: z.string().optional(),
  // Unpaid-booking dressing: remind after N ms, then ask-and-cancel after M ms.
  PAYMENT_REMIND_MS: z.coerce.number().optional(), // default 15 min
  PAYMENT_CANCEL_MS: z.coerce.number().optional(), // default 30 min

  WAPI_BASE_URL: z.string().optional(),
  WAPI_TOKEN: z.string().optional(),

  HOUSEKEEPING_CHAT_ID: z.string().optional(),
  OWNER_CHAT_ID: z.string().optional(),

  // Admin API (apartment editor served on Netlify).
  ADMIN_TOKEN: z.string().optional(), // legacy single-token (kept for /api/admin compat)
  ADMIN_CORS_ORIGIN: z.string().default('*'), // set to the front origin in prod
  JWT_SECRET: z.string().default('dev-insecure-change-me'), // signs owner login tokens
  // Pilot: which owner's apartment catalog the agent serves in chat.
  AGENT_OWNER_ID: z.string().optional(),

  PMS_PROVIDER: z.enum(['stub', 'realtycalendar']).default('stub'),
  RC_BASE_URL: z.string().default('https://realtycalendar.ru'),
  RC_USER_TOKEN: z.string().optional(), // x-user-token header
  RC_COOKIE: z.string().optional(),
  RC_USER_AGENT: z.string().default('Mozilla/5.0'),
  // Default deposit when creating a payment link. Owner's real standard deposit
  // is 2500 ₽ (from chat screenshots; 1500 on a couple of flats). Per-owner
  // creds can override via pms_credentials.defaultDeposit.
  RC_DEFAULT_DEPOSIT: z.coerce.number().default(2500),

  DATABASE_URL: z.string().optional(),

  AUTONOMY_ENABLED: bool(true),
  MAX_BOOKING_TOTAL: z.coerce.number().default(1_000_000),
  MIN_BOOKING_TOTAL: z.coerce.number().default(1_000),
  // House policy: minimum nights per stay, applied globally on top of any
  // per-room Bnovo minstay (the effective floor is the max of the two). Bnovo
  // returns no minstay for these flats, so this is what actually enforces the
  // owner's "не бронировать меньше 3 суток" rule. Set MIN_NIGHTS=1 to disable.
  MIN_NIGHTS: z.coerce.number().default(3),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
