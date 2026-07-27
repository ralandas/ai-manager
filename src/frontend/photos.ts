import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { config } from '../config.js';

/**
 * Per-apartment photos. Uploaded via the admin panel, stored under
 * data/photos/<aptId>/, served publicly so the messenger can send them by URL
 * and the agent can caption them with title + price.
 */
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../../data/photos');

const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function aptDir(id: string): string {
  // Guard against path traversal — ids are numeric RC ids, keep it strict.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(ROOT, safe);
}

export function listPhotoFiles(id: string): string[] {
  const dir = aptDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ALLOWED.has(extname(f).toLowerCase()))
    .sort();
}

/** Public URLs for an apartment's photos (what the messenger sends). */
export function listPhotoUrls(id: string): string[] {
  const base = config.PUBLIC_URL?.replace(/\/$/, '') ?? `http://localhost:${config.PORT}`;
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return listPhotoFiles(id).map((f) => `${base}/photos/${safe}/${f}`);
}

export function savePhoto(id: string, buffer: Buffer, originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error(`unsupported file type: ${ext}`);
  const dir = aptDir(id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Deterministic-ish name by index+ext; avoid Date.now for reproducibility.
  const n = listPhotoFiles(id).length + 1;
  const name = `photo-${n}${ext}`;
  writeFileSync(join(dir, name), buffer);
  return name;
}

export function deletePhoto(id: string, file: string): boolean {
  const safeFile = file.replace(/[^a-zA-Z0-9_.-]/g, '');
  const path = join(aptDir(id), safeFile);
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  unlinkSync(path);
  return true;
}

export function photosRoot(): string {
  return ROOT;
}
