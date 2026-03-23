import { geminiCliService } from '../../services/gemini-cli.service.js';
import { chatHistory } from '../chat-history.js';
import { logger } from '../../logger.js';
import type { ToolDefinition } from '../../services/llm.types.js';
import type { SessionId } from '../../core/channel-types.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

export function getGeminiCliTools(sessionId: SessionId): {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}[] {
  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'gemini_cli_delegate',
          description:
            'Delegate a larger coding task to Gemini CLI (runs in background, auto-approves edits). Use when the user asks for multi-file refactors, complex features, or self-improvement. Set continue_session=true when the user wants to iterate on the previous Gemini result (e.g. "change that to X", "fix the bug") – continues in the same Gemini session.',
          parameters: {
            type: 'object',
            required: ['task'],
            properties: {
              task: {
                type: 'string',
                description:
                  'Clear description of the task. For iterations: describe the follow-up change. For self-improvement: include "create a feature branch, make the changes, commit, push, gh pr create. Never commit to main."',
              },
              continue_session: {
                type: 'boolean',
                description:
                  'If true, resume the latest Gemini CLI session and run this task as a follow-up. Use when the user wants to iterate on the previous result (same chat history).',
              },
              workspace: {
                type: 'string',
                description:
                  'Optional subpath under the allowed workspace root. E.g. "backend" or "packages/core". Leave empty for project root.',
              },
              include_dirs: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional directories to include in context. E.g. ["src", "tests"].',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const task = typeof args.task === 'string' ? args.task.trim() : '';
        if (!task) {
          return { ok: false, output: 'task is required.' };
        }
        const workspace =
          typeof args.workspace === 'string' ? args.workspace.trim() || undefined : undefined;
        const includeDirs = Array.isArray(args.include_dirs)
          ? (args.include_dirs as string[]).map((d) => String(d).trim()).filter(Boolean)
          : undefined;
        const continueSession = args.continue_session === true;

        const contextSnapshot = chatHistory.getContextSnapshot(sessionId, task);

        try {
          const id = await geminiCliService.startJob(
            sessionId,
            task,
            contextSnapshot,
            workspace,
            includeDirs,
            continueSession
          );
          return {
            ok: true,
            output: continueSession
              ? `Gemini CLI job started (ID: ${id}), continuing in the same session. You will be notified when it finishes.`
              : `Gemini CLI job started (ID: ${id}). It is running in the background. You will receive the result for review when it finishes. Tell the user: "I've handed this off to Gemini CLI. It may take a few minutes. I'll review the result and notify you when it's done."`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, sessionId }, 'gemini_cli_delegate failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'gemini_cli_status',
          description:
            'List Gemini CLI jobs for this chat. Use when the user asks "what is Gemini doing" or "status of my coding task".',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async () => {
        try {
          const jobs = await geminiCliService.listJobs(sessionId);
          if (jobs.length === 0) {
            return { ok: true, output: 'No Gemini CLI jobs.' };
          }
          const lines = jobs.slice(0, 10).map((j) => {
            const status = j.status;
            const task = j.task.slice(0, 60) + (j.task.length > 60 ? '...' : '');
            return `- [${j.id.slice(0, 8)}] ${status}: ${task}`;
          });
          return { ok: true, output: lines.join('\n') };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, sessionId }, 'gemini_cli_status failed');
          return { ok: false, output: msg };
        }
      },
    },
  ];
}
