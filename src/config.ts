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

  LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-latest'),

  MESSENGER: z.enum(['telegram', 'max']).default('telegram'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().default('change-me'),

  WAPI_BASE_URL: z.string().optional(),
  WAPI_TOKEN: z.string().optional(),

  HOUSEKEEPING_CHAT_ID: z.string().optional(),
  OWNER_CHAT_ID: z.string().optional(),

  PMS_PROVIDER: z.enum(['stub', 'realtycalendar']).default('stub'),
  RC_BASE_URL: z.string().default('https://realtycalendar.ru'),
  RC_USER_TOKEN: z.string().optional(), // x-user-token header
  RC_COOKIE: z.string().optional(),
  RC_USER_AGENT: z.string().default('Mozilla/5.0'),
  // Default deposit amount (minor units) when creating a payment link.
  RC_DEFAULT_DEPOSIT: z.coerce.number().default(2500),

  DATABASE_URL: z.string().optional(),

  AUTONOMY_ENABLED: bool(true),
  MAX_BOOKING_TOTAL: z.coerce.number().default(1_000_000),
  MIN_BOOKING_TOTAL: z.coerce.number().default(1_000),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
