/**
 * Self-update: git pull, npm install, npm run build, then exit.
 * Local reload: build only, then exit (for Gemini CLI self-improvements).
 * Expects a process manager (systemd, PM2, Docker) to restart.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { chatHistory } from '../core/chat-history.js';

export type UpdateMode = 'full' | 'local';

function getProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      cwd: process.cwd(),
    }).trim();
  } catch {
    return path.resolve(process.cwd(), '..');
  }
}

export async function performUpdate(mode: UpdateMode = 'full'): Promise<{ ok: boolean; output: string }> {
  const root = getProjectRoot();
  const backendInRoot = path.join(root, 'backend');
  const backendDir = fs.existsSync(path.join(backendInRoot, 'package.json'))
    ? backendInRoot
    : root;
  const logs: string[] = [];

  try {
    logger.info({ mode }, 'Starting self-update');

    chatHistory.persistAll();
    logs.push('Chat history persisted.');

    if (mode === 'full') {
      execSync('git pull', { cwd: root, encoding: 'utf-8' });
      logs.push('git pull ok');
      execSync('npm install', { cwd: backendDir, encoding: 'utf-8' });
      logs.push('npm install ok');
    }

    execSync('npm run build', { cwd: backendDir, encoding: 'utf-8' });
    logs.push('npm run build ok');

    logger.info('Self-update complete, exiting for restart');
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Self-update failed');
    return {
      ok: false,
      output: logs.length ? `${logs.join('\n')}\n\nError: ${msg}` : `Error: ${msg}`,
    };
  }
}
