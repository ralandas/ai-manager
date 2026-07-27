import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';

const __dir = dirname(fileURLToPath(import.meta.url));
// Editable content lives outside the compiled code so the owner can change texts
// without a redeploy. One JSON keyed by RC apartment id.
const DATA_PATH = join(__dir, '../../data/apartments-info.json');

export interface ApartmentInfo {
  /** RC apartment id (string). */
  id: string;
  title: string;
  address?: string;
  /** House rules, free text (may contain line breaks). */
  rules?: string;
  /** Remote self-check-in instructions, specific to this apartment. */
  checkinInstructions?: string;
  wifi?: { name?: string; password?: string };
  extra?: string;
}

let cache: Record<string, ApartmentInfo> | null = null;

function load(): Record<string, ApartmentInfo> {
  if (cache) return cache;
  if (!existsSync(DATA_PATH)) {
    logger.warn({ path: DATA_PATH }, 'apartments-info.json not found — empty info set');
    cache = {};
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Record<string, ApartmentInfo>;
  } catch (err) {
    logger.error({ err }, 'failed to parse apartments-info.json');
    cache = {};
  }
  return cache;
}

/** Force a reload on next access (e.g. after the owner edits the file). */
export function invalidateApartmentInfo(): void {
  cache = null;
}

export function getApartmentInfo(id: string): ApartmentInfo | null {
  return load()[id] ?? null;
}
