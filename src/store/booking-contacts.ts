import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';

/**
 * Maps a PMS booking to the messenger chat that created it, so we can reach the
 * guest later (e.g. the day-before-checkout reminder). RC stores the guest phone
 * but no chat id, so we persist the link ourselves at booking time.
 *
 * Simple JSON file — fine for the pilot's volume; swap for Postgres later.
 */
const __dir = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dir, '../../data');
const PATH = join(DIR, 'booking-contacts.json');

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
}

function load(): Record<string, BookingContact> {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, 'utf8')) as Record<string, BookingContact>;
  } catch (err) {
    logger.error({ err }, 'booking-contacts: parse failed, starting empty');
    return {};
  }
}

function save(all: Record<string, BookingContact>): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(all, null, 2));
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

export function allBookingContacts(): BookingContact[] {
  return Object.values(load());
}
