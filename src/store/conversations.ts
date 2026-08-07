import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';
import type { LlmMessage } from '../llm/types.js';
import type { AgentSession } from '../agent/tools.js';

/**
 * Persistent per-chat conversation state.
 *
 * The agent kept history + session in memory, so every process restart wiped
 * every dialog — the bot "forgot" and re-greeted mid-conversation. We persist
 * both to a JSON file (same simple approach as booking-contacts) so a restart
 * or crash keeps the context. Swap for Postgres later if volume grows.
 */
const __dir = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dir, '../../data');
const PATH = join(DIR, 'conversations.json');

interface ConversationRecord {
  history: LlmMessage[];
  session: AgentSession;
  updatedAt: number;
}
type Store = Record<string, ConversationRecord>;

function load(): Store {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, 'utf8')) as Store;
  } catch (err) {
    logger.error({ err }, 'conversations: parse failed, starting empty');
    return {};
  }
}

function save(all: Store): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(all));
}

export interface ConversationState {
  history: LlmMessage[];
  session: AgentSession;
}

/** Load one chat's state (empty if unseen). */
export function loadConversation(chatId: string): ConversationState {
  const rec = load()[chatId];
  return { history: rec?.history ?? [], session: rec?.session ?? {} };
}

/** Persist one chat's state after a turn. */
export function saveConversation(chatId: string, state: ConversationState): void {
  const all = load();
  all[chatId] = { history: state.history, session: state.session, updatedAt: Date.now() };
  save(all);
}
