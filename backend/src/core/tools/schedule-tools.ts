import { taskSchedulerService } from '../../services/task-scheduler.service.js';
import { logger } from '../../logger.js';
import type { ToolDefinition } from '../../services/llm.types.js';
import type { SessionId } from '../../core/channel-types.js';
import { config } from '../../config.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

export function getScheduleTools(sessionId: SessionId): {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}[] {
  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'schedule_reminder',
          description:
            'Schedule a one-time reminder. Use when the user asks to be reminded later (e.g. "remind me in 1 hour", "remind me in 30 minutes", "remind me tomorrow at 9").',
          parameters: {
            type: 'object',
            required: ['message', 'delay_minutes'],
            properties: {
              message: {
                type: 'string',
                description:
                  'What to remind about. This will be sent to the agent when the reminder fires. Be concise, e.g. "Reminder: User asked to take medicine" or "Reminder: Call back the client".',
              },
              delay_minutes: {
                type: 'number',
                description:
                  'Minutes from now when the reminder should fire. Use 60 for 1 hour, 1440 for 24 hours (1 day).',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        const delayMinutes = Number(args.delay_minutes);
        if (!message) {
          return { ok: false, output: 'Message is required.' };
        }
        if (!Number.isFinite(delayMinutes) || delayMinutes < 1) {
          return { ok: false, output: 'delay_minutes must be a positive number.' };
        }
        try {
          const id = await taskSchedulerService.addInMinutes(
            sessionId,
            Math.min(delayMinutes, 525600),
            `[Reminder] ${message}`
          );
          const mins = Math.round(delayMinutes);
          const desc =
            mins >= 1440
              ? `${Math.round(mins / 1440)} day(s)`
              : mins >= 60
                ? `${Math.round(mins / 60)} hour(s)`
                : `${mins} minute(s)`;
          return {
            ok: true,
            output: `Reminder scheduled in ${desc}. (ID: ${id})`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, sessionId }, 'schedule_reminder failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'schedule_daily',
          description:
            'Schedule a daily recurring task (e.g. "send me the weather every morning at 10", "daily report at 9am"). Uses the configured default timezone.',
          parameters: {
            type: 'object',
            required: ['message', 'hour', 'minute'],
            properties: {
              message: {
                type: 'string',
                description:
                  'What to do each day. Sent to the agent at the scheduled time. E.g. "Get the weather forecast and send it to the user" or "Send daily briefing: calendar, weather, top emails".',
              },
              hour: {
                type: 'number',
                description: 'Hour (0-23) in 24h format. E.g. 10 for 10:00.',
              },
              minute: {
                type: 'number',
                description: 'Minute (0-59). E.g. 0 for :00.',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        const hour = Number(args.hour);
        const minute = Number(args.minute);
        if (!message) {
          return { ok: false, output: 'Message is required.' };
        }
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return { ok: false, output: 'hour must be 0-23.' };
        }
        if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
          return { ok: false, output: 'minute must be 0-59.' };
        }
        try {
          const id = await taskSchedulerService.addDaily(
            sessionId,
            hour,
            minute,
            config.schedulerDefaultTimezone,
            `[Daily] ${message}`
          );
          const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
          return {
            ok: true,
            output: `Daily task scheduled at ${timeStr} (${config.schedulerDefaultTimezone} timezone). (ID: ${id})`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, sessionId }, 'schedule_daily failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'schedule_weekly',
          description:
            'Schedule a weekly recurring task (e.g. "every Monday at 9am send weekly recap", "every Sunday evening remind me to plan the week"). Uses the configured default timezone. day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday.',
          parameters: {
            type: 'object',
            required: ['message', 'day_of_week', 'hour', 'minute'],
            properties: {
              message: {
                type: 'string',
                description:
                  'What to do each week. E.g. "Generate weekly recap and send to user" or "Remind user to plan the week".',
              },
              day_of_week: {
                type: 'number',
                description: 'Day: 0=Sunday, 1=Monday, 2=Tuesday, ..., 6=Saturday',
              },
              hour: {
                type: 'number',
                description: 'Hour (0-23) in 24h format.',
              },
              minute: {
                type: 'number',
                description: 'Minute (0-59).',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        const dayOfWeek = Number(args.day_of_week);
        const hour = Number(args.hour);
        const minute = Number(args.minute);
        if (!message) {
          return { ok: false, output: 'Message is required.' };
        }
        if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
          return { ok: false, output: 'day_of_week must be 0-6 (0=Sun, 1=Mon, ..., 6=Sat).' };
        }
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return { ok: false, output: 'hour must be 0-23.' };
        }
        if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
          return { ok: false, output: 'minute must be 0-59.' };
        }
        try {
          const id = await taskSchedulerService.addWeekly(
            sessionId,
            dayOfWeek,
            hour,
            minute,
            config.schedulerDefaultTimezone,
            `[Weekly] ${message}`
          );
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
          return {
            ok: true,
            output: `Weekly task scheduled: every ${dayNames[dayOfWeek]} at ${timeStr} (${config.schedulerDefaultTimezone} timezone). (ID: ${id})`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, sessionId }, 'schedule_weekly failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'schedule_list',
          description:
            'List all scheduled reminders, daily and weekly tasks for this chat. Use when the user asks "what reminders do I have" or "list my scheduled tasks".',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async () => {
        try {
          const tasks = await taskSchedulerService.list(sessionId);
          if (tasks.length === 0) {
            return { ok: true, output: 'No scheduled tasks.' };
          }
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const lines = tasks.map((t) => {
            const runAt = new Date(t.runAt);
            const timeStr = runAt.toLocaleString();
            if (t.type === 'once') {
              return `- [${t.id}] Reminder at ${timeStr}: "${t.message.replace(/^\[Reminder\] /, '')}"`;
            }
            if (t.type === 'weekly') {
              const day = t.dayOfWeek !== undefined ? dayNames[t.dayOfWeek] : '?';
              return `- [${t.id}] Weekly ${day} ${String(t.hour ?? 0).padStart(2, '0')}:${String(t.minute ?? 0).padStart(2, '0')}: "${t.message.replace(/^\[Weekly\] /, '')}"`;
            }
            return `- [${t.id}] Daily at ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}: "${t.message.replace(/^\[Daily\] /, '')}"`;
          });
          return { ok: true, output: lines.join('\n') };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, sessionId }, 'schedule_list failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'schedule_cancel',
          description:
            'Cancel a scheduled task. Use when the user wants to cancel a reminder or daily task. Call schedule_list first to get the task ID if unknown.',
          parameters: {
            type: 'object',
            required: ['task_id'],
            properties: {
              task_id: {
                type: 'string',
                description: 'The task ID from schedule_list.',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
        if (!taskId) {
          return { ok: false, output: 'task_id is required.' };
        }
        const tasks = await taskSchedulerService.list(sessionId);
        const ownsTask = tasks.some((t) => t.id === taskId);
        if (!ownsTask) {
          return { ok: false, output: `Task "${taskId}" not found or not in this chat.` };
        }
        const ok = await taskSchedulerService.cancel(taskId);
        return {
          ok: true,
          output: ok ? 'Task cancelled.' : 'Task not found.',
        };
      },
    },
  ];
}
