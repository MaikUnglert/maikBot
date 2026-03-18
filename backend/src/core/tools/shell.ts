import { exec } from 'child_process';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const MAX_OUTPUT_BYTES = 10_000;

export interface ShellResult {
  ok: boolean;
  output: string;
}

export async function executeShell(command: string): Promise<ShellResult> {
  const startedAt = Date.now();
  logger.info({ command }, 'Executing shell command');

  return new Promise<ShellResult>((resolve) => {
    exec(
      command,
      {
        timeout: config.shellTimeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        shell: '/bin/bash',
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        const truncated =
          combined.length > MAX_OUTPUT_BYTES
            ? combined.slice(0, MAX_OUTPUT_BYTES) + '\n...(truncated)'
            : combined;

        if (error) {
          const timedOut = error.killed || error.code === null;
          const message = timedOut
            ? `Command timed out after ${config.shellTimeoutMs}ms`
            : `Exit code ${error.code ?? 'unknown'}`;

          logger.warn(
            { command, durationMs, exitCode: error.code, timedOut },
            'Shell command failed'
          );

          resolve({
            ok: false,
            output: truncated ? `${message}\n${truncated}` : message,
          });
          return;
        }

        logger.info(
          { command, durationMs, outputLength: combined.length },
          'Shell command completed'
        );

        resolve({
          ok: true,
          output: truncated || '(no output)',
        });
      }
    );
  });
}
