import { logger } from '../logger.js';
import type { LlmProvider } from '../llm/types.js';
import type { Messenger, IncomingMessage } from '../messenger/types.js';
import type { PmsConnector } from '../pms/types.js';
import { buildTools } from './tools.js';
import { systemPrompt } from './prompt.js';
import { loadConversation, saveConversation } from '../store/conversations.js';
import { config } from '../config.js';

const MAX_HISTORY = 30;

/**
 * Words of a reply, stemmed crudely, as a set. The model rarely repeats itself
 * byte-for-byte — it rephrases the same non-answer ("на 5 гостей подходит" /
 * "5 гостей подходят" / "5 гостям подходит"), so exact or prefix comparison
 * misses real loops. Trimming Russian inflectional endings makes those forms
 * collide.
 */
function replyTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.replace(/(ами|ями|ов|ей|ам|ям|ах|ях|ые|ая|ое|ую|ет|ут|ют|ит|ат|у|ы|и|а|е|о|я|ь)$/, '')),
  );
}

/** Numbers carry the facts: address, price, dates, guest count. */
function replyNumbers(text: string): Set<string> {
  return new Set(text.replace(/\s+/g, '').match(/\d+/g) ?? []);
}

/**
 * How much two replies overlap, 0..1 (Jaccard over content words). Two
 * rephrasings of one holding sentence share nearly all their words; a genuine
 * next step (asking the guest's name, quoting a price) shares few.
 *
 * Numbers veto a match. Offering two different flats reuses the same sentence
 * frame ("X свободна на 20 сентября, N ₽ за сутки. Бронируем?") and scores high
 * on words alone — but the address and price differ, and that is exactly what
 * makes it progress rather than a loop. A real loop repeats the same facts.
 */
function replySimilarity(a: string, b: string): number {
  const [x, y] = [replyTokens(a), replyTokens(b)];
  if (x.size === 0 || y.size === 0) return 0;
  const [na, nb] = [replyNumbers(a), replyNumbers(b)];
  if (na.size > 0 && nb.size > 0) {
    const sameNumbers = na.size === nb.size && [...na].every((n) => nb.has(n));
    if (!sameNumbers) return 0;
  }
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Above this, two replies say the same thing. Tuned on the real looped chat:
 * consecutive rephrasings of the same holding sentence scored 0.53–0.86, while
 * genuine next steps (asking a name, quoting a price, refusing on capacity)
 * scored 0.00–0.20 — so 0.45 sits in a wide gap, well clear of both.
 */
const REPEAT_THRESHOLD = 0.45;

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
      turnMsgId: msg.providerMessageId,
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

    // Stuck-loop guard. When a tool keeps returning the same non-answer (e.g.
    // Bnovo omits a price because the party exceeds capacity), the model can
    // repeat one holding phrase forever — the guest says "ок", it says "уточню
    // стоимость" again, and the dialog never advances. Prompt rules alone don't
    // guarantee this (they're probabilistic), so enforce it here: if this reply
    // matches either of our last two, stop repeating and hand off to a human.
    const priorReplies = history.filter((h) => h.role === 'assistant').slice(-2);
    if (priorReplies.some((h) => replySimilarity(h.text, reply) >= REPEAT_THRESHOLD)) {
      logger.warn({ chatId: msg.chatId, reply }, 'agent: repeated reply suppressed — escalating');
      reply =
        'Извините, здесь мне нужна помощь администратора — передаю ему ваш запрос, он ответит с точной информацией.';
      if (config.OWNER_CHAT_ID) {
        await this.messenger
          .sendMessage(
            config.OWNER_CHAT_ID,
            `⚠️ Бот зациклился в чате ${msg.chatId} и был остановлен. Последнее сообщение гостя: «${msg.text}». Нужен ответ вручную.`,
          )
          .catch(() => {});
      } else {
        // No owner chat configured — the guest still gets the honest hand-off
        // reply above, but nobody is paged. Make that visible in the logs.
        logger.warn({ chatId: msg.chatId }, 'agent: loop escalation not delivered — OWNER_CHAT_ID unset');
      }
    }

    history.push({ role: 'assistant', text: reply });
    // Persist trimmed history + session (session may hold lastBookingId).
    saveConversation(msg.chatId, { history: history.slice(-MAX_HISTORY), session });

    await this.messenger.sendMessage(msg.chatId, reply);
  }
}
