import { mcpHostService } from '../services/mcp-host.service.js';
import { executeShell, getShellJobResult } from './tools/shell.js';
import { performUpdate } from '../services/update.service.js';
import { getScheduleTools } from './tools/schedule-tools.js';
import { getGeminiCliTools } from './tools/gemini-cli-tools.js';
import { getAgentConfigTools } from './tools/agent-config-tools.js';
import { getBrowserTools } from './tools/browser-tools.js';
import { getVisionTools } from './tools/vision-tools.js';
import { getScanTools } from './tools/scan-tools.js';
import { logger } from '../logger.js';
import type { ToolDefinition } from '../services/llm.types.js';

import type { SessionId } from './channel-types.js';

export interface LoadToolsContext {
  sessionId: SessionId;
}

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

interface RegisteredTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    (schema as Record<string, unknown>).type === 'object'
  ) {
    return schema as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

function getBuiltInTools(): RegisteredTool[] {
  const shell: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'shell_exec',
        description:
          'Execute a shell command on the server. Use for file read/write/edit (cat, echo, sed), system info, network checks, package management. Set async=true for long-running commands (returns job ID; use shell_job_result to fetch output later).',
        parameters: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              description: 'The bash command to execute',
            },
            async: {
              type: 'boolean',
              description:
                'If true, run in background and return job ID. Use shell_job_result to get output when done.',
            },
          },
        },
      },
    },
    execute: async (args) => {
      const command = typeof args.command === 'string' ? args.command : String(args.command ?? '');
      if (!command.trim()) {
        return { ok: false, output: 'No command provided.' };
      }
      const runAsync = args.async === true;
      return executeShell(command, runAsync);
    },
  };

  const shellJobResult: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'shell_job_result',
        description:
          'Get the output of an async shell command (shell_exec with async=true). Use when the user asks "what was the result" or to check if a background job is done.',
        parameters: {
          type: 'object',
          required: ['job_id'],
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID returned by shell_exec when async=true.',
            },
          },
        },
      },
    },
    execute: async (args) => {
      const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
      if (!jobId) {
        return { ok: false, output: 'job_id is required.' };
      }
      const result = await getShellJobResult(jobId);
      const statusLine =
        result.status === 'running'
          ? 'Still running.'
          : result.status === 'completed'
            ? `Completed (exit ${result.exitCode ?? 0}).`
            : `Failed (exit ${result.exitCode ?? '?'}).`;
      return {
        ok: result.ok,
        output: `${statusLine}\n\n${result.output}`,
      };
    },
  };

  const maikbotSelfUpdate: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'maikbot_self_update',
        description:
          'Pull latest code, build, and restart maikBot. Use when the user asks to update the bot (e.g. "update dich", "aktualisiere dich", "pull latest"). The process will exit and restart automatically.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['full', 'local'],
              description:
                'full: git pull, npm install, build, restart. local: build only, restart (e.g. after Gemini CLI changes).',
            },
          },
        },
      },
    },
    execute: async (args) => {
      const mode = (args.mode === 'local' ? 'local' : 'full') as 'full' | 'local';
      const result = await performUpdate(mode);
      return result;
    },
  };

  const agentConfig = getAgentConfigTools().map((t) => ({
    definition: t.definition,
    execute: t.execute,
  }));

  return [shell, shellJobResult, maikbotSelfUpdate, ...agentConfig];
}

export class ToolRegistry {
  private builtInTools: RegisteredTool[] = getBuiltInTools();

  /**
   * Loads all tools, optionally filtered to only the names in `allowedNames`.
   * When `allowedNames` is provided, only tools whose name is in the set are returned.
   * Schedule tools (schedule_*) require `context.sessionId` to be set.
   */
  async loadTools(
    allowedNames?: Set<string>,
    context?: LoadToolsContext
  ): Promise<{
    definitions: ToolDefinition[];
    dispatch: Map<string, (args: Record<string, unknown>) => Promise<ToolExecResult>>;
  }> {
    const definitions: ToolDefinition[] = [];
    const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<ToolExecResult>>();

    if (mcpHostService.isConfigured()) {
      const mcpTools = await mcpHostService.listTools();
      for (const tool of mcpTools) {
        const name = tool.name;
        if (allowedNames && !allowedNames.has(name)) continue;

        definitions.push({
          type: 'function',
          function: {
            name,
            description: tool.description ?? '',
            parameters: normalizeInputSchema(tool.inputSchema),
          },
        });

        dispatch.set(name, async (args) => {
          const result = await mcpHostService.callTool(name, args, {
            server: tool.server,
            explicitUserCommand: true,
          });
          return result;
        });
      }
    }

    for (const tool of this.builtInTools) {
      const name = tool.definition.function.name;
      if (allowedNames && !allowedNames.has(name)) continue;
      definitions.push(tool.definition);
      dispatch.set(name, tool.execute);
      if (name === 'shell_exec') {
        dispatch.set('shell', tool.execute);
      }
    }

    const scheduleToolNames = new Set<string>([
      'schedule_reminder',
      'schedule_daily',
      'schedule_weekly',
      'schedule_list',
      'schedule_cancel',
    ]);
    const needsSchedule =
      (!allowedNames ||
        [...scheduleToolNames].some((n) => allowedNames.has(n))) &&
      context?.sessionId;
    if (needsSchedule && context) {
      for (const tool of getScheduleTools(context.sessionId)) {
        const name = tool.definition.function.name;
        if (allowedNames && !allowedNames.has(name)) continue;
        definitions.push(tool.definition);
        dispatch.set(name, tool.execute);
      }
    }

    const geminiCliToolNames = new Set<string>(['gemini_cli_delegate', 'gemini_cli_status']);
    const needsGeminiCli =
      (!allowedNames ||
        [...geminiCliToolNames].some((n) => allowedNames.has(n))) &&
      context?.sessionId;
    if (needsGeminiCli && context) {
      for (const tool of getGeminiCliTools(context.sessionId)) {
        const name = tool.definition.function.name;
        if (allowedNames && !allowedNames.has(name)) continue;
        definitions.push(tool.definition);
        dispatch.set(name, tool.execute);
      }
    }

    const browserToolNames = new Set<string>([
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_screenshot_analyze',
      'browser_click',
      'browser_type',
      'browser_close',
    ]);
    const needsBrowser =
      !allowedNames || [...browserToolNames].some((n) => allowedNames.has(n));
    if (needsBrowser) {
      for (const tool of getBrowserTools()) {
        const name = tool.definition.function.name;
        if (allowedNames && !allowedNames.has(name)) continue;
        definitions.push(tool.definition);
        dispatch.set(name, tool.execute);
      }
    }

    const visionToolNames = new Set<string>(['vision_analyze_image']);
    const needsVision = !allowedNames || [...visionToolNames].some((n) => allowedNames.has(n));
    if (needsVision) {
      for (const tool of getVisionTools()) {
        const name = tool.definition.function.name;
        if (allowedNames && !allowedNames.has(name)) continue;
        definitions.push(tool.definition);
        dispatch.set(name, tool.execute);
      }
    }

    const scanToolNames = new Set<string>(['scan_add_page', 'scan_status', 'scan_cancel']);
    const needsScan =
      (!allowedNames || [...scanToolNames].some((n) => allowedNames.has(n))) && context?.sessionId;
    if (needsScan && context) {
      for (const tool of getScanTools(context.sessionId)) {
        const name = tool.definition.function.name;
        if (allowedNames && !allowedNames.has(name)) continue;
        definitions.push(tool.definition);
        dispatch.set(name, tool.execute);
      }
    }

    logger.info(
      { total: definitions.length, filtered: !!allowedNames },
      'Tool registry loaded'
    );

    return { definitions, dispatch };
  }
}

export const toolRegistry = new ToolRegistry();
