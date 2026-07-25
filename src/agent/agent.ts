import { logger } from '../logger.js';
import type { LlmMessage, LlmProvider } from '../llm/types.js';
import type { Messenger, IncomingMessage } from '../messenger/types.js';
import type { PmsConnector } from '../pms/types.js';
import { buildTools, type AgentSession } from './tools.js';
import { systemPrompt } from './prompt.js';

const MAX_HISTORY = 30;

/**
 * The conversational agent. Keeps per-chat history (in-memory for the pilot —
 * swap for Postgres later), runs an LLM turn with the PMS-backed tools, and
 * sends the reply back through the messenger.
 */
export class Agent {
  private readonly histories = new Map<string, LlmMessage[]>();
  private readonly sessions = new Map<string, AgentSession>();
  /** Dedup by provider message id so webhook retries don't double-process. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly llm: LlmProvider,
    private readonly pms: PmsConnector,
    private readonly messenger: Messenger,
  ) {}

  async handle(msg: IncomingMessage): Promise<void> {
    const dedupKey = `${msg.chatId}:${msg.providerMessageId}`;
    if (this.seen.has(dedupKey)) return;
    this.seen.add(dedupKey);

    const history = this.histories.get(msg.chatId) ?? [];
    history.push({ role: 'user', text: msg.text });

    const session = this.sessions.get(msg.chatId) ?? {};
    this.sessions.set(msg.chatId, session);
    const tools = buildTools({
      pms: this.pms,
      messenger: this.messenger,
      chatId: msg.chatId,
      session,
    });
    const today = new Date().toISOString().slice(0, 10);

    let reply: string;
    try {
      reply = await this.llm.runTurn({
        systemPrompt: systemPrompt(today),
        history,
        tools,
      });
    } catch (err) {
      logger.error({ err, chatId: msg.chatId }, 'agent turn failed');
      reply = 'Извините, произошла техническая заминка. Попробуйте, пожалуйста, ещё раз.';
    }

    history.push({ role: 'assistant', text: reply });
    this.histories.set(msg.chatId, history.slice(-MAX_HISTORY));

    await this.messenger.sendMessage(msg.chatId, reply);
  }
}
