import { readFileSync, existsSync } from 'node:fs';
import { logger } from '../logger.js';
import { dataPath, writeJsonAtomic } from './paths.js';
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
const FILE = 'conversations.json';

interface ConversationRecord {
  history: LlmMessage[];
  session: AgentSession;
  updatedAt: number;
}
type Store = Record<string, ConversationRecord>;

function load(): Store {
  const path = dataPath(FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Store;
  } catch (err) {
    logger.error({ err }, 'conversations: parse failed, starting empty');
    return {};
  }
}

function save(all: Store): void {
  writeJsonAtomic(FILE, all);
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
