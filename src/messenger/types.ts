/**
 * Messenger abstraction. Telegram is the first implementation; Max (via Wapi)
 * plugs in later behind the same interface — the agent never talks to a
 * concrete messenger directly.
 */

export interface IncomingMessage {
  /** Stable per-messenger chat id (string to survive large ints). */
  chatId: string;
  /** Sender display name if the messenger provides one. */
  senderName?: string;
  text: string;
  /** Provider-native message id, for dedup/idempotency. */
  providerMessageId: string;
  /** Unix seconds. */
  timestamp: number;
  /**
   * Text/caption of the message this one replies to, if any. Guests often reply
   * to a photo album ("5 Красноармейская 28 — 8000 ₽") with "эту"/"давайте её";
   * the caption is our only clue which apartment they mean, so we surface it.
   */
  quotedText?: string;
}

export interface Messenger {
  readonly name: 'telegram' | 'max';
  /** Send a plain-text message to a chat. */
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Send photos (by public URL) with an optional shared caption. */
  sendPhotos?(chatId: string, urls: string[], caption?: string): Promise<void>;
  /**
   * Register the HTTP webhook route(s) on the given Fastify instance and,
   * where applicable, tell the provider where to deliver updates.
   */
  init(): Promise<void>;
}

/** Handler the transport calls for every normalized inbound message. */
export type MessageHandler = (msg: IncomingMessage) => Promise<void>;
