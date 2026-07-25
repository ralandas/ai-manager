import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './logger.js';
import { GeminiProvider } from './llm/gemini.js';
import { TelegramMessenger } from './messenger/telegram.js';
import type { Messenger } from './messenger/types.js';
import { createPms } from './pms/index.js';
import { Agent } from './agent/agent.js';
import { Housekeeping, scheduleDaily } from './housekeeping.js';

async function main() {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));

  const pms = createPms();
  const llm = new GeminiProvider();

  // Messenger needs the message handler, but the handler needs the messenger to
  // reply — resolve with a late-bound reference.
  let agent: Agent;
  let messenger: Messenger;

  if (config.MESSENGER === 'telegram') {
    messenger = new TelegramMessenger(app, (msg) => agent.handle(msg));
  } else {
    throw new Error(`Messenger "${config.MESSENGER}" not implemented yet (Max/Wapi is on the roadmap)`);
  }

  agent = new Agent(llm, pms, messenger);
  await messenger.init();

  // Nightly checkout forecast for the cleaners.
  const housekeeping = new Housekeeping(pms, messenger);
  scheduleDaily(21, () => housekeeping.postTomorrowForecast());

  // Manual trigger for the forecast (useful for testing without waiting for 21:00).
  app.post('/admin/forecast', async () => {
    await housekeeping.postTomorrowForecast();
    return { ok: true };
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, messenger: config.MESSENGER, pms: config.PMS_PROVIDER }, 'AI manager up');
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
