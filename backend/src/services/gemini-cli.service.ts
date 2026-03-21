import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { SessionId } from '../core/channel-types.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface GeminiCliJob {
  id: string;
  sessionId: SessionId;
  task: string;
  status: JobStatus;
  workspace: string;
  includeDirs: string[];
  createdAt: string;
  completedAt?: string;
  pid?: number;
  contextSnapshot: {
    userRequest: string;
    recentMessages: Array<{ role: string; content: string }>;
  };
  result?: {
    response?: string;
    stats?: Record<string, unknown>;
    error?: { message: string; code?: number };
    exitCode?: number;
  };
  reviewedAt?: string;
}

function getJobPath(id: string): string {
  return path.join(config.jobsDataDir, `${id}.json`);
}

async function ensureJobsDir(): Promise<void> {
  await fs.mkdir(config.jobsDataDir, { recursive: true });
}

/** Resolve workspace path; must be within GEMINI_CLI_WORKSPACE_ROOT. */
function resolveWorkspace(workspace: string | undefined): string {
  const root = config.geminiCliWorkspaceRoot;
  const resolved = workspace
    ? path.resolve(root, workspace)
    : root;
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Workspace must be under ${root}`);
  }
  return resolved;
}

/** List all job IDs. */
async function listJobIds(): Promise<string[]> {
  try {
    await ensureJobsDir();
    const entries = await fs.readdir(config.jobsDataDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export const geminiCliService = {
  /**
   * Start a Gemini CLI job. Spawns in background, returns immediately.
   */
  async startJob(
    sessionId: SessionId,
    task: string,
    contextSnapshot: GeminiCliJob['contextSnapshot'],
    workspace?: string,
    includeDirs?: string[]
  ): Promise<string> {
    const id = randomUUID();
    const resolvedWorkspace = resolveWorkspace(workspace);
    const dirs = Array.isArray(includeDirs) ? includeDirs : [];

    const job: GeminiCliJob = {
      id,
      sessionId,
      task,
      status: 'pending',
      workspace: resolvedWorkspace,
      includeDirs: dirs,
      createdAt: new Date().toISOString(),
      contextSnapshot,
    };

    await ensureJobsDir();
    await fs.writeFile(
      getJobPath(id),
      JSON.stringify(job, null, 2),
      'utf-8'
    );

    const args: string[] = [
      '-p',
      task,
      '--yolo',
      '--output-format',
      'json',
    ];
    if (dirs.length > 0) {
      args.push('--include-directories', dirs.join(','));
    }

    const proc = spawn('gemini', args, {
      cwd: resolvedWorkspace,
      env: { ...process.env, GEMINI_YOLO_MODE: 'true' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    job.status = 'running';
    job.pid = proc.pid;
    await fs.writeFile(
      getJobPath(id),
      JSON.stringify(job, null, 2),
      'utf-8'
    );

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
        const completedAt = new Date().toISOString();
        let parsed: { response?: string; stats?: Record<string, unknown>; error?: { message: string; code?: number } } = {};
        try {
          const lastBrace = stdout.lastIndexOf('}');
          if (lastBrace >= 0) {
            const jsonStr = stdout.slice(stdout.lastIndexOf('{', lastBrace), lastBrace + 1);
            parsed = JSON.parse(jsonStr) as typeof parsed;
          }
        } catch {
          /* keep empty parsed */
        }

        const updated: GeminiCliJob = {
          ...job,
          status: code === 0 ? 'completed' : 'failed',
          completedAt,
          result: {
            response: parsed.response,
            stats: parsed.stats,
            error: parsed.error ?? (code !== 0 ? { message: stderr || `Exit ${code} ${signal ?? ''}`.trim() } : undefined),
            exitCode: code ?? undefined,
          },
        };
        delete updated.pid;

        try {
          await fs.writeFile(
            getJobPath(id),
            JSON.stringify(updated, null, 2),
            'utf-8'
          );
          logger.info(
            { jobId: id, sessionId, exitCode: code },
            'Gemini CLI job finished'
          );
        } catch (err) {
          logger.error({ err, jobId: id }, 'Failed to persist job result');
        }
      })();
    });

    proc.unref();

    logger.info({ jobId: id, sessionId, task: task.slice(0, 60) }, 'Gemini CLI job started');
    return id;
  },

  async getJob(id: string): Promise<GeminiCliJob | null> {
    try {
      const data = await fs.readFile(getJobPath(id), 'utf-8');
      const raw = JSON.parse(data) as Record<string, unknown>;
      const sessionId =
        typeof raw.sessionId === 'string'
          ? raw.sessionId
          : typeof raw.chatId === 'number'
            ? `tg:${raw.chatId}`
            : null;
      if (!sessionId) return null;
      return { ...raw, sessionId } as GeminiCliJob;
    } catch {
      return null;
    }
  },

  async listJobs(sessionId?: SessionId): Promise<GeminiCliJob[]> {
    const ids = await listJobIds();
    const jobs: GeminiCliJob[] = [];
    for (const id of ids) {
      const job = await this.getJob(id);
      if (job && (sessionId === undefined || job.sessionId === sessionId)) {
        jobs.push(job);
      }
    }
    return jobs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  },

  async hasRunningJobs(): Promise<boolean> {
    const ids = await listJobIds();
    for (const id of ids) {
      const job = await this.getJob(id);
      if (job?.status === 'running') return true;
    }
    return false;
  },

  async getCompletedJobsForReview(): Promise<GeminiCliJob[]> {
    const ids = await listJobIds();
    const jobs: GeminiCliJob[] = [];
    for (const id of ids) {
      const job = await this.getJob(id);
      if (job && (job.status === 'completed' || job.status === 'failed') && !job.reviewedAt) {
        jobs.push(job);
      }
    }
    return jobs;
  },

  async markJobReviewed(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;
    job.reviewedAt = new Date().toISOString();
    await fs.writeFile(getJobPath(id), JSON.stringify(job, null, 2), 'utf-8');
  },

  async deleteJob(id: string): Promise<boolean> {
    try {
      await fs.unlink(getJobPath(id));
      return true;
    } catch {
      return false;
    }
  },
};
