/**
 * End-to-end agent test WITHOUT a messenger: drives a scripted conversation
 * through the real GeminiProvider + StubPms + tools, printing each reply.
 * Run: npx tsx src/scripts/e2e-agent.ts
 */
import { GeminiProvider } from '../llm/gemini.js';
import { StubPms } from '../pms/stub.js';
import { buildTools } from '../agent/tools.js';
import { systemPrompt } from '../agent/prompt.js';
import type { LlmMessage } from '../llm/types.js';
import type { Messenger } from '../messenger/types.js';

// Fake messenger that just records outbound owner/housekeeping messages.
const sent: string[] = [];
const fakeMessenger: Messenger = {
  name: 'telegram',
  async init() {},
  async sendMessage(chatId, text) {
    sent.push(`[to ${chatId}] ${text}`);
  },
};

async function main() {
  const llm = new GeminiProvider();
  const pms = new StubPms();
  const chatId = 'test-chat';
  const tools = buildTools({ pms, messenger: fakeMessenger, chatId, session: {} });
  const today = new Date().toISOString().slice(0, 10);
  const history: LlmMessage[] = [];

  const userTurns = [
    'Привет! Хочу снять квартиру на двоих с 1 по 3 августа 2026. Что есть?',
    'Давай студию в центре. Меня зовут Рауан, бронируй.',
    'Отлично, дай ссылку на оплату.',
  ];

  for (const text of userTurns) {
    console.log(`\n👤 USER: ${text}`);
    history.push({ role: 'user', text });
    const reply = await llm.runTurn({ systemPrompt: systemPrompt(today), history, tools });
    history.push({ role: 'assistant', text: reply });
    console.log(`🤖 AGENT: ${reply}`);
  }

  console.log('\n--- owner/system notifications captured ---');
  for (const s of sent) console.log(s);
}

main().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
