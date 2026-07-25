import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Guardrails around autonomous, money-touching actions. On the pilot the agent
 * books and takes payment with no human in the loop, so every risky call passes
 * through here first.
 */

export class AutonomyDisabledError extends Error {
  constructor() {
    super('Autonomous actions are disabled (kill-switch AUTONOMY_ENABLED=false)');
  }
}

export class ValidationError extends Error {}

/** Master kill-switch. Flip AUTONOMY_ENABLED=false to freeze all bookings/payments. */
export function assertAutonomyEnabled(): void {
  if (!config.AUTONOMY_ENABLED) throw new AutonomyDisabledError();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateBooking(input: {
  checkIn: string;
  checkOut: string;
  guests: number;
  totalPrice: number;
}): void {
  if (!ISO_DATE.test(input.checkIn) || !ISO_DATE.test(input.checkOut)) {
    throw new ValidationError('Даты должны быть в формате YYYY-MM-DD');
  }
  if (Date.parse(input.checkIn) >= Date.parse(input.checkOut)) {
    throw new ValidationError('Дата выезда должна быть позже даты заезда');
  }
  // Reject check-in in the past (compare by date string, TZ-agnostic enough for pilot).
  const today = new Date().toISOString().slice(0, 10);
  if (input.checkIn < today) {
    throw new ValidationError('Дата заезда не может быть в прошлом');
  }
  if (input.guests <= 0) throw new ValidationError('Число гостей должно быть больше нуля');
  if (input.totalPrice < config.MIN_BOOKING_TOTAL) {
    throw new ValidationError(`Сумма брони подозрительно мала (< ${config.MIN_BOOKING_TOTAL})`);
  }
  if (input.totalPrice > config.MAX_BOOKING_TOTAL) {
    throw new ValidationError(`Сумма брони выше лимита (> ${config.MAX_BOOKING_TOTAL})`);
  }
}

/** Stable idempotency key from booking essentials — same request never books twice. */
export function bookingIdempotencyKey(input: {
  chatId: string;
  propertyId: string;
  checkIn: string;
  checkOut: string;
}): string {
  return `${input.chatId}:${input.propertyId}:${input.checkIn}:${input.checkOut}`;
}

/** Structured audit trail for every autonomous action. */
export function audit(action: string, detail: Record<string, unknown>): void {
  logger.info({ audit: action, ...detail }, `AUDIT ${action}`);
}
