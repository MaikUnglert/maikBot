import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import { wakeHeartbeat } from './heartbeat-wake.js';
import type { SessionId } from '../core/channel-types.js';

export interface ScheduledTask {
  id: string;
  sessionId: SessionId;
  type: 'once' | 'daily' | 'weekly';
  /** ISO string for next run (UTC) */
  runAt: string;
  /** For daily/weekly: hour (0-23) and minute (0-59) in server local time */
  hour?: number;
  minute?: number;
  /** For weekly: day of week 0=Sunday, 1=Monday, ..., 6=Saturday */
  dayOfWeek?: number;
  message: string;
  createdAt: string;
}

const TASKS_FILE = 'tasks.json';

function getTasksPath(): string {
  return path.join(config.schedulerDataDir, TASKS_FILE);
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.schedulerDataDir, { recursive: true });
}

/** Normalize legacy chatId (number) to sessionId. */
function toSessionId(raw: { chatId?: number; sessionId?: string }): SessionId | null {
  if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) {
    return raw.sessionId;
  }
  if (typeof raw.chatId === 'number') {
    return `tg:${raw.chatId}`;
  }
  return null;
}

async function loadTasks(): Promise<ScheduledTask[]> {
  try {
    const p = getTasksPath();
    const data = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: ScheduledTask[] = [];
    for (const t of parsed) {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string') continue;
      const sessionId = toSessionId(t as { chatId?: number; sessionId?: string });
      if (!sessionId) continue;
      const type = t.type;
      if (type !== 'once' && type !== 'daily' && type !== 'weekly') continue;
      if (typeof t.runAt !== 'string' || typeof t.message !== 'string') continue;
      result.push({
        id: t.id,
        sessionId,
        type,
        runAt: t.runAt,
        hour: t.hour,
        minute: t.minute,
        dayOfWeek: t.dayOfWeek,
        message: t.message,
        createdAt: t.createdAt ?? new Date().toISOString(),
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  await ensureDataDir();
  const p = getTasksPath();
  await fs.writeFile(p, JSON.stringify(tasks, null, 2), 'utf-8');
}

/** Compute next run for daily task (server local time). */
function nextDailyRun(hour: number, minute: number): Date {
  const now = new Date();
  let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/** Compute next run for weekly task (server local time). dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat */
function nextWeeklyRun(dayOfWeek: number, hour: number, minute: number): Date {
  const now = new Date();
  const currentDay = now.getDay();
  let daysUntil = (dayOfWeek - currentDay + 7) % 7;
  if (daysUntil === 0) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (candidate <= now) daysUntil = 7;
  }
  const next = new Date(now);
  next.setDate(next.getDate() + daysUntil);
  next.setHours(hour, minute, 0, 0);
  return next;
}

export const taskSchedulerService = {
  /**
   * Add a one-time reminder.
   * @param sessionId Channel session ID (e.g. tg:123 or wa:49123@s.whatsapp.net)
   */
  async addOnce(sessionId: SessionId, runAt: Date | string, message: string): Promise<string> {
    const id = randomUUID();
    const runAtDate = typeof runAt === 'string' ? new Date(runAt) : runAt;
    const task: ScheduledTask = {
      id,
      sessionId,
      type: 'once',
      runAt: runAtDate.toISOString(),
      message,
      createdAt: new Date().toISOString(),
    };
    const tasks = await loadTasks();
    tasks.push(task);
    await saveTasks(tasks);
    logger.info({ id, sessionId, runAt: task.runAt }, 'Scheduled one-time reminder');
    wakeHeartbeat();
    return id;
  },

  /**
   * Add a daily recurring task.
   */
  async addDaily(
    sessionId: SessionId,
    hour: number,
    minute: number,
    message: string
  ): Promise<string> {
    const id = randomUUID();
    const next = nextDailyRun(hour, minute);
    const task: ScheduledTask = {
      id,
      sessionId,
      type: 'daily',
      runAt: next.toISOString(),
      hour,
      minute,
      message,
      createdAt: new Date().toISOString(),
    };
    const tasks = await loadTasks();
    tasks.push(task);
    await saveTasks(tasks);
    logger.info({ id, sessionId, hour, minute, nextRun: task.runAt }, 'Scheduled daily task');
    wakeHeartbeat();
    return id;
  },

  /** Add reminder in N minutes from now. */
  async addInMinutes(
    sessionId: SessionId,
    delayMinutes: number,
    message: string
  ): Promise<string> {
    const runAt = new Date(Date.now() + delayMinutes * 60 * 1000);
    return this.addOnce(sessionId, runAt, message);
  },

  /** Add reminder in N hours from now. */
  async addInHours(sessionId: SessionId, delayHours: number, message: string): Promise<string> {
    return this.addInMinutes(sessionId, delayHours * 60, message);
  },

  /**
   * Add a weekly recurring task.
   */
  async addWeekly(
    sessionId: SessionId,
    dayOfWeek: number,
    hour: number,
    minute: number,
    message: string
  ): Promise<string> {
    const id = randomUUID();
    const next = nextWeeklyRun(dayOfWeek, hour, minute);
    const task: ScheduledTask = {
      id,
      sessionId,
      type: 'weekly',
      runAt: next.toISOString(),
      dayOfWeek,
      hour,
      minute,
      message,
      createdAt: new Date().toISOString(),
    };
    const tasks = await loadTasks();
    tasks.push(task);
    await saveTasks(tasks);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    logger.info(
      { id, sessionId, dayOfWeek: dayNames[dayOfWeek], hour, minute, nextRun: task.runAt },
      'Scheduled weekly task'
    );
    wakeHeartbeat();
    return id;
  },

  async cancel(id: string): Promise<boolean> {
    const tasks = await loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    tasks.splice(idx, 1);
    await saveTasks(tasks);
    logger.info({ id }, 'Cancelled scheduled task');
    return true;
  },

  async list(sessionId?: SessionId): Promise<ScheduledTask[]> {
    const tasks = await loadTasks();
    if (sessionId !== undefined) {
      return tasks.filter((t) => t.sessionId === sessionId);
    }
    return tasks;
  },

  /**
   * Returns ms until the soonest task is due. Infinity if no tasks.
   * Does not modify tasks (read-only).
   */
  async getMsUntilNextDue(): Promise<number> {
    const tasks = await loadTasks();
    if (tasks.length === 0) return Infinity;
    const now = Date.now();
    let minMs = Infinity;
    for (const t of tasks) {
      const runAt = new Date(t.runAt).getTime();
      if (runAt > now) {
        minMs = Math.min(minMs, runAt - now);
      } else {
        return 0; // at least one is due now
      }
    }
    return minMs;
  },

  /**
   * Get all tasks that are due (runAt <= now).
   * Reschedules daily/weekly tasks and removes completed one-time tasks.
   */
  async getAndProcessDueTasks(): Promise<ScheduledTask[]> {
    const now = new Date();
    const tasks = await loadTasks();
    const due: ScheduledTask[] = [];
    const remaining: ScheduledTask[] = [];

    for (const task of tasks) {
      const runAt = new Date(task.runAt);
      if (runAt <= now) {
        due.push(task);
        if (task.type === 'daily' && task.hour !== undefined && task.minute !== undefined) {
          const next = nextDailyRun(task.hour, task.minute);
          remaining.push({ ...task, runAt: next.toISOString() });
        } else if (
          task.type === 'weekly' &&
          task.dayOfWeek !== undefined &&
          task.hour !== undefined &&
          task.minute !== undefined
        ) {
          const next = nextWeeklyRun(task.dayOfWeek, task.hour, task.minute);
          remaining.push({ ...task, runAt: next.toISOString() });
        }
      } else {
        remaining.push(task);
      }
    }

    if (due.length > 0) {
      await saveTasks(remaining);
    }
    return due;
  },
};
