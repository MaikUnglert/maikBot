import { exec, spawn } from 'child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const MAX_OUTPUT_BYTES = 10_000;

export interface ShellResult {
  ok: boolean;
  output: string;
}

export interface ShellJobResult {
  ok: boolean;
  output: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
}

function getJobPath(jobId: string): string {
  return path.join(config.shellJobsDataDir, `${jobId}.json`);
}

async function ensureShellJobsDir(): Promise<void> {
  await fs.mkdir(config.shellJobsDataDir, { recursive: true });
}

export async function executeShell(
  command: string,
  async: boolean = false
): Promise<ShellResult> {
  if (async) {
    const jobId = randomUUID();
    await ensureShellJobsDir();
    const jobPath = getJobPath(jobId);

    const proc = spawn('/bin/bash', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    proc.on('close', (code, signal) => {
      void (async () => {
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        const truncated =
          combined.length > MAX_OUTPUT_BYTES
            ? combined.slice(0, MAX_OUTPUT_BYTES) + '\n...(truncated)'
            : combined;
        const job = {
          status: code === 0 ? 'completed' : 'failed',
          exitCode: code ?? undefined,
          output: truncated || '(no output)',
          command: command.slice(0, 200),
          completedAt: new Date().toISOString(),
        };
        try {
          await fs.writeFile(jobPath, JSON.stringify(job, null, 2), 'utf-8');
        } catch (err) {
          logger.error({ err, jobId }, 'Failed to write shell job result');
        }
        logger.info({ jobId, exitCode: code }, 'Async shell command completed');
      })();
    });

    proc.unref();

    logger.info({ jobId, command: command.slice(0, 80) }, 'Async shell command started');
    return {
      ok: true,
      output: `Command started in background (ID: ${jobId}). Tell the user: "I've started the command in the background. You can ask me 'is it done?' or 'what was the result?' and I'll check for you." Store the job_id "${jobId}" for when the user asks for the result.`,
    };
  }

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

export async function getShellJobResult(jobId: string): Promise<ShellJobResult> {
  try {
    const data = await fs.readFile(getJobPath(jobId), 'utf-8');
    const job = JSON.parse(data) as {
      status: string;
      exitCode?: number;
      output?: string;
    };
    if (job.status === 'completed') {
      return {
        ok: true,
        output: job.output ?? '(no output)',
        status: 'completed',
        exitCode: job.exitCode,
      };
    }
    return {
      ok: false,
      output: job.output ?? 'Command failed',
      status: 'failed',
      exitCode: job.exitCode,
    };
  } catch {
    return {
      ok: false,
      output: `Job "${jobId}" not found or still running.`,
      status: 'running',
    };
  }
}
