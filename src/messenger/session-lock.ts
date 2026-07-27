import { createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

/**
 * Per-SESSION lock. The hard lesson from the Lead Zavod pool: two different
 * processes on the SAME StringSession make Telegram invalidate the auth key
 * (AUTH_KEY_DUPLICATED) — the account dies. A per-process/per-mode lock does NOT
 * prevent this; the lock must be keyed by the SESSION itself.
 *
 * We use an atomic O_CREAT|O_EXCL file named by the session hash. If the lock
 * exists but its PID is dead (stale), we reclaim it. Same host only — good
 * enough here since all our processes run on one VPS.
 */
export class SessionLock {
  private readonly path: string;
  private held = false;

  constructor(session: string) {
    const hash = createHash('sha256').update(session).digest('hex').slice(0, 16);
    this.path = join(tmpdir(), `ai-manager-tg-session-${hash}.lock`);
  }

  /** Acquire or throw. Reclaims a stale lock whose PID is no longer alive. */
  acquire(): void {
    if (this.tryCreate()) return;

    // Lock exists — check whether the owning PID is still alive.
    let ownerPid = 0;
    try {
      ownerPid = parseInt(readFileSync(this.path, 'utf8').trim(), 10) || 0;
    } catch {
      /* unreadable — treat as stale */
    }
    if (ownerPid && this.pidAlive(ownerPid)) {
      throw new Error(
        `Telegram session already in use by PID ${ownerPid} (lock ${this.path}). ` +
          `Refusing to connect — two processes on one session get the account banned.`,
      );
    }
    // Stale lock: remove and retry once.
    logger.warn({ path: this.path, ownerPid }, 'reclaiming stale session lock');
    try {
      unlinkSync(this.path);
    } catch {
      /* raced away */
    }
    if (!this.tryCreate()) {
      throw new Error(`Failed to acquire session lock ${this.path} after reclaiming stale lock`);
    }
  }

  release(): void {
    if (!this.held) return;
    try {
      unlinkSync(this.path);
    } catch {
      /* already gone */
    }
    this.held = false;
  }

  private tryCreate(): boolean {
    try {
      const fd = openSync(this.path, 'wx'); // wx = O_CREAT|O_EXCL, fails if exists
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      this.held = true;
      // Best-effort cleanup on exit.
      const off = () => this.release();
      process.once('exit', off);
      process.once('SIGINT', () => {
        this.release();
        process.exit(0);
      });
      process.once('SIGTERM', () => {
        this.release();
        process.exit(0);
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return true;
    } catch (err) {
      // ESRCH = no such process; EPERM = exists but not ours (still alive).
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

export function sessionLockExists(session: string): boolean {
  const hash = createHash('sha256').update(session).digest('hex').slice(0, 16);
  return existsSync(join(tmpdir(), `ai-manager-tg-session-${hash}.lock`));
}
