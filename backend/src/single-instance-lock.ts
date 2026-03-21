/**
 * Prevents multiple maikBot instances from running simultaneously.
 * Fixes Telegram 409 (getUpdates conflict) and WhatsApp 440 (connection replaced)
 * when the user accidentally starts the bot twice.
 */
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = path.resolve(process.cwd(), 'data', '.maikbot.lock');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSingleInstanceLock(): void {
  const dataDir = path.dirname(LOCK_FILE);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    /* dir may already exist */
  }

  const tryAcquire = (): void => {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }

    try {
      const content = fs.readFileSync(LOCK_FILE, 'utf8');
      const pid = Number.parseInt(content.trim(), 10);
      if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
        fs.unlinkSync(LOCK_FILE);
        tryAcquire();
        return;
      }
    } catch {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* ignore */
      }
      tryAcquire();
      return;
    }

    throw new Error(
      `Another maikBot instance is already running. Stop it first to avoid Telegram 409 and WhatsApp conflict errors.`
    );
  };

  tryAcquire();

  process.once('exit', () => {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  });
}
