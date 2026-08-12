import { readFileSync, existsSync } from 'node:fs';
import { logger } from '../logger.js';
import { dataPath, writeJsonAtomic } from './paths.js';

/**
 * Maps a PMS booking to the messenger chat that created it, so we can reach the
 * guest later (e.g. the day-before-checkout reminder). RC stores the guest phone
 * but no chat id, so we persist the link ourselves at booking time.
 *
 * Simple JSON file — fine for the pilot's volume; swap for Postgres later.
 */
const FILE = 'booking-contacts.json';

export interface BookingContact {
  bookingId: string;
  chatId: string;
  guestName: string;
  propertyId: string;
  checkOut: string;
  /** Guest-confirmed exact checkout time, once known (e.g. "11:30"). */
  checkoutTime?: string;
  /** Epoch ms when the booking was created — bounds how long we poll payment. */
  createdAt?: number;
  /** Set once we've told the guest their payment arrived (dedupe the notice). */
  paidNotified?: boolean;
  /** Unpaid-dressing state: sent the "не оплатили?" reminder / cancelled it. */
  paymentReminded?: boolean;
  cancelled?: boolean;
}

function load(): Record<string, BookingContact> {
  const path = dataPath(FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, BookingContact>;
  } catch (err) {
    logger.error({ err }, 'booking-contacts: parse failed, starting empty');
    return {};
  }
}

function save(all: Record<string, BookingContact>): void {
  writeJsonAtomic(FILE, all);
}

export function rememberBookingContact(c: BookingContact): void {
  const all = load();
  all[c.bookingId] = { ...all[c.bookingId], ...c };
  save(all);
}

export function getBookingContact(bookingId: string): BookingContact | null {
  return load()[bookingId] ?? null;
}

export function setCheckoutTime(bookingId: string, time: string): void {
  const all = load();
  const existing = all[bookingId];
  if (!existing) return;
  existing.checkoutTime = time;
  save(all);
}

export function markPaidNotified(bookingId: string): void {
  const all = load();
  const existing = all[bookingId];
  if (!existing) return;
  existing.paidNotified = true;
  save(all);
}

export function patchBookingContact(bookingId: string, patch: Partial<BookingContact>): void {
  const all = load();
  const existing = all[bookingId];
  if (!existing) return;
  all[bookingId] = { ...existing, ...patch };
  save(all);
}

export function allBookingContacts(): BookingContact[] {
  return Object.values(load());
}

/**
 * Is this booking's payment link effectively dead? True if we explicitly
 * cancelled it (unpaid past the deadline) OR its hold window has long expired.
 *
 * The watcher only cancels bookings inside its polling window (createdAt within
 * cancelMs + 1h). A booking created days ago fell out of that window before the
 * cancel branch ever fired, so `cancelled` stays false even though its 30-min
 * hold — and thus its invoice link — expired long ago. Guarding on age too means
 * the bot never points a guest at a dead link for an old, never-paid booking.
 */
export function isPaymentWindowDead(
  c: BookingContact | null,
  cancelMs: number,
  now: number,
): boolean {
  if (!c) return false;
  if (c.cancelled) return true;
  if (c.paidNotified) return false; // paid — link served its purpose, not "dead"
  if (c.createdAt && now - c.createdAt > cancelMs) return true;
  return false;
}
