/**
 * Self-update: git pull, npm install, npm run build, then exit.
 * Local reload: build only, then exit (for Gemini CLI self-improvements).
 * When run under systemd/PM2/Docker: exits and lets the process manager restart.
 * When run manually (npm run start): spawns a new process before exiting.
 */
import { execSync, spawn } from 'node:child_process';
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

export interface PerformUpdateOptions {
  /** Called before exit on success – allows sending "Update complete" to the user. */
  onSuccess?: (message: string) => Promise<void>;
}

export async function performUpdate(
  mode: UpdateMode = 'full',
  options?: PerformUpdateOptions
): Promise<{ ok: boolean; output: string }> {
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
      // NODE_ENV=production skips devDependencies – we need typescript for build
      execSync('npm install --include=dev', { cwd: backendDir, encoding: 'utf-8' });
      logs.push('npm install ok');
    }

    const tscPath = path.join(backendDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tscPath)) {
      throw new Error(`TypeScript not found at ${tscPath}. Run npm install first.`);
    }
    execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(tscPath)} -p tsconfig.json`, {
      cwd: backendDir,
      encoding: 'utf-8',
    });
    logs.push('npm run build ok');

    logger.info('Self-update complete, exiting for restart');

    const successMsg = mode === 'full' ? 'Update complete. Restarting…' : 'Reload complete. Restarting…';
    await options?.onSuccess?.(successMsg);

    // When under systemd/PM2/Docker, just exit – process manager restarts.
    // When run manually, spawn a delayed restart so the new process starts AFTER we release the lock.
    if (!process.env.MAIKBOT_RESTART_BY && !process.env.INVOCATION_ID) {
      const logPath = path.join(root, 'data', 'restart.log');
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      const npmPath = execSync('which npm', { encoding: 'utf-8', env: { ...process.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } }).trim();
      const cmd = `sleep 3 && cd ${JSON.stringify(root)} && ${JSON.stringify(npmPath)} run start >> ${JSON.stringify(logPath)} 2>&1`;
      // Use setsid so the child runs in a new session and survives when we exit (avoids SIGHUP).
      const setsidPath = fs.existsSync('/usr/bin/setsid') ? '/usr/bin/setsid' : 'setsid';
      const child = spawn(setsidPath, ['sh', '-c', cmd], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      });
      child.unref();
      logger.info({ logPath, npmPath }, 'Spawned delayed restart (3s, logs in data/restart.log)');
      process.exit(0);
    }
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
