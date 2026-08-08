import { logger } from '../logger.js';
import type { LlmProvider } from '../llm/types.js';
import type { Messenger, IncomingMessage } from '../messenger/types.js';
import type { PmsConnector } from '../pms/types.js';
import { buildTools } from './tools.js';
import { systemPrompt } from './prompt.js';
import { loadConversation, saveConversation } from '../store/conversations.js';

const MAX_HISTORY = 30;

/**
 * The conversational agent. Per-chat history + session are PERSISTED to disk
 * (store/conversations.ts) so a process restart or crash keeps the dialog
 * context — otherwise the bot "forgets" and re-greets mid-conversation. Runs an
 * LLM turn with the PMS-backed tools and sends the reply through the messenger.
 */
export class Agent {
  /** Dedup by provider message id so webhook retries don't double-process.
   *  (In-memory only; on restart the persisted history still prevents a re-greet.) */
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

    // Load persisted context for this chat (survives restarts).
    const { history, session } = loadConversation(msg.chatId);
    // If the guest replied to one of our messages (e.g. a photo album captioned
    // with an apartment address), fold that caption into the turn so the model
    // knows what "эту"/"давайте её" points at instead of re-asking.
    const userText = msg.quotedText
      ? `[в ответ на наше сообщение: "${msg.quotedText}"]\n${msg.text}`
      : msg.text;
    history.push({ role: 'user', text: userText });

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
    // Persist trimmed history + session (session may hold lastBookingId).
    saveConversation(msg.chatId, { history: history.slice(-MAX_HISTORY), session });

    await this.messenger.sendMessage(msg.chatId, reply);
  }
}
