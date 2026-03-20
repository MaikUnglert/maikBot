import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';

/** Safe filename stem only (no path). */
const DOMAIN_RE = /^[a-z][a-z0-9_]{0,48}$/;

const MAX_FILE_BYTES = 96 * 1024;

export function assertValidDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(
      `Invalid domain "${domain}". Use lowercase letters, digits, underscore only (e.g. home_assistant).`
    );
  }
}

export function pathForDomain(domain: string): string {
  assertValidDomain(domain);
  return path.join(config.memoryDataDir, `${domain}.md`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const j = haystack.indexOf(needle, i);
    if (j === -1) break;
    n++;
    i = j + needle.length;
  }
  return n;
}

export async function readDomainFile(domain: string): Promise<{ exists: boolean; content: string }> {
  const filePath = pathForDomain(domain);
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(
        `Memory file exceeds ${MAX_FILE_BYTES} bytes. Shorten it on the server before using tools.`
      );
    }
    return { exists: true, content: buf.toString('utf8') };
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    if (code === 'ENOENT') return { exists: false, content: '' };
    throw err;
  }
}

export async function appendDomainFile(domain: string, text: string): Promise<void> {
  assertValidDomain(domain);
  const filePath = pathForDomain(domain);
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  await fs.mkdir(config.memoryDataDir, { recursive: true });

  let current = '';
  try {
    current = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    if (code !== 'ENOENT') throw err;
  }

  const glue = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  const next = current + glue + chunk;
  if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(
      `Append would exceed max size (${MAX_FILE_BYTES} bytes). Shorten with memory_str_replace or delete lines manually.`
    );
  }
  await fs.writeFile(filePath, next, 'utf8');
}

export async function strReplaceDomainFile(
  domain: string,
  oldString: string,
  newString: string
): Promise<void> {
  if (!oldString) {
    throw new Error('old_string must be non-empty (exact substring from memory_read).');
  }
  const { exists, content } = await readDomainFile(domain);
  if (!exists) {
    throw new Error(`No memory file for domain "${domain}" yet. Use memory_append first.`);
  }
  const matches = countOccurrences(content, oldString);
  if (matches === 0) {
    throw new Error(
      'old_string not found (must be exact, including spaces and newlines). Re-read the file and copy the block.'
    );
  }
  if (matches > 1) {
    throw new Error(
      `old_string matched ${matches} times. Include more surrounding lines so the match is unique.`
    );
  }
  const updated = content.replace(oldString, newString);
  if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`Result would exceed max size (${MAX_FILE_BYTES} bytes).`);
  }
  await fs.writeFile(pathForDomain(domain), updated, 'utf8');
}
