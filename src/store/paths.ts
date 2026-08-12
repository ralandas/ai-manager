import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { config } from '../config.js';

/**
 * Where the JSON stores live, and how to write them safely.
 *
 * Two bot processes (RC + Bnovo) run from one checkout. With a shared ./data
 * dir they clobber each other's files; DATA_DIR gives each its own. And a bare
 * writeFileSync leaves a truncated/half-written file if the process is killed
 * mid-write (our deploy = scp + pm2 restart, and conversations.json is written
 * on every message) — a later JSON.parse then throws and the store silently
 * resets to {}. writeJsonAtomic writes a temp file and renames it over the
 * target: rename is atomic on the same filesystem, so a reader sees either the
 * old whole file or the new whole file, never a torn one.
 */

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(__dir, '../../data');

/** Absolute data directory for this process (DATA_DIR override, else ./data). */
export function dataDir(): string {
  const d = config.DATA_DIR;
  if (!d) return DEFAULT_DIR;
  return isAbsolute(d) ? d : join(__dir, '../../', d);
}

/** Absolute path to a file inside this process's data dir. */
export function dataPath(file: string): string {
  return join(dataDir(), file);
}

/** Write JSON atomically: temp file + rename, so a crash never leaves a torn file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  // Unique-ish temp name without Date.now/Math.random (both fine here, but keep
  // it dependency-free): pid + a monotonic counter.
  const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, target);
}

let tmpCounter = 0;
