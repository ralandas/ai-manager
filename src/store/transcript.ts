import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';

/**
 * Append-only chat transcript.
 *
 * conversations.json is the agent's WORKING memory — trimmed to the last N
 * turns, so it's not a durable record. For after-the-fact analysis of every
 * dialog we also append each message (in and out, text and photos) to a
 * newline-delimited JSON log that is never trimmed. One line = one event, so
 * it's cheap to append, easy to grep, and safe to tail while the bot runs.
 *
 * Best-effort: a logging failure must never break message handling, so every
 * write is wrapped and swallowed with a warning.
 */
const __dir = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dir, '../../logs');
const PATH = join(DIR, 'transcript.jsonl');

export type TranscriptDirection = 'in' | 'out';
export type TranscriptKind = 'text' | 'photo';

export interface TranscriptEntry {
  /** Telegram chat id (string form, as everywhere else in the app). */
  chatId: string;
  /** 'in' = from the guest, 'out' = from the bot. */
  dir: TranscriptDirection;
  /** 'text' for a message, 'photo' for a sent album/image. */
  kind: TranscriptKind;
  /** Message body or, for photos, the caption / a short descriptor. */
  text?: string;
  /** Guest display name, when known (inbound only). */
  senderName?: string;
  /** Provider (Telegram) message id, when known. */
  providerMessageId?: string;
  /** How many photos in this send (photo kind only). */
  photoCount?: number;
}

/**
 * Append one transcript line. `ts` is stamped here (ISO). Never throws.
 */
export function logTranscript(entry: TranscriptEntry): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    appendFileSync(PATH, line);
  } catch (err) {
    logger.warn({ err, chatId: entry.chatId }, 'transcript: append failed');
  }
}
