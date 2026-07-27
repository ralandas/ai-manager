import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { photosRoot } from './frontend/photos.js';
import { GeminiProvider } from './llm/gemini.js';
import { TelegramMessenger } from './messenger/telegram.js';
import { TelegramUserMessenger } from './messenger/telegram-user.js';
import type { Messenger } from './messenger/types.js';
import { createPms } from './pms/index.js';
import { Agent } from './agent/agent.js';
import { Housekeeping, scheduleDaily } from './housekeeping.js';
import { registerFrontend } from './frontend/routes.js';
import { registerAdminApi } from './frontend/admin-api.js';

async function main() {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB/photo

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));

  registerFrontend(app);

  // Public photo serving: /photos/:id/:file (streamed from data/photos).
  const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  app.get<{ Params: { id: string; file: string } }>('/photos/:id/:file', async (req, reply) => {
    const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const file = req.params.file.replace(/[^a-zA-Z0-9_.-]/g, '');
    const path = join(photosRoot(), id, file);
    if (!existsSync(path) || !statSync(path).isFile()) return reply.code(404).send('not found');
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(createReadStream(path));
  });

  const pms = createPms();
  const llm = new GeminiProvider();

  // Admin API for the Vercel-hosted apartment-info editor.
  registerAdminApi(app, pms);

  // Messenger needs the message handler, but the handler needs the messenger to
  // reply — resolve with a late-bound reference.
  let agent: Agent;
  let messenger: Messenger;

  if (config.MESSENGER === 'telegram') {
    messenger = new TelegramMessenger(app, (msg) => agent.handle(msg));
  } else if (config.MESSENGER === 'telegram-user') {
    messenger = new TelegramUserMessenger((msg) => agent.handle(msg));
  } else {
    throw new Error(`Messenger "${config.MESSENGER}" not implemented yet (Max/Wapi is on the roadmap)`);
  }

  agent = new Agent(llm, pms, messenger);
  await messenger.init();

  const housekeeping = new Housekeeping(pms, messenger);
  // Evening: DM guests to confirm tomorrow's exact checkout time...
  scheduleDaily(18, () => housekeeping.remindGuestsAboutCheckout());
  // ...then post the cleaners' prep list (with any confirmed times).
  scheduleDaily(21, () => housekeeping.postTomorrowForecast());

  // Manual triggers (test without waiting for the scheduled hour).
  app.post('/admin/forecast', async () => {
    await housekeeping.postTomorrowForecast();
    return { ok: true };
  });
  app.post('/admin/checkout-reminders', async () => {
    await housekeeping.remindGuestsAboutCheckout();
    return { ok: true };
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, messenger: config.MESSENGER, pms: config.PMS_PROVIDER }, 'AI manager up');
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
