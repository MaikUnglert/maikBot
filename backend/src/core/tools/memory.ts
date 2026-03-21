import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const MEMORY_FILENAME = 'memory.md';
const MAX_FILE_BYTES = 128 * 1024;

export async function readMemory(): Promise<string> {
  const filePath = path.join(config.memoryDataDir, MEMORY_FILENAME);
  try {
    const buf = await fs.readFile(filePath, 'utf8');
    if (Buffer.byteLength(buf, 'utf8') > MAX_FILE_BYTES) {
      logger.warn('memory.md exceeds max size, truncating in read');
      return buf.slice(0, MAX_FILE_BYTES) + '\n...(truncated)';
    }
    return buf;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    if (code === 'ENOENT') return '';
    throw err;
  }
}
