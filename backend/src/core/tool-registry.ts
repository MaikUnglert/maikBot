import { mcpHostService } from '../services/mcp-host.service.js';
import { executeShell } from './tools/shell.js';
import { getMemoryTools } from './tools/memory-tools.js';
import { logger } from '../logger.js';
import type { ToolDefinition } from '../services/llm.types.js';

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
          'Execute a shell command on the server and return stdout/stderr. Use for system info, file operations, network checks, package management, or any CLI task.',
        parameters: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              description: 'The bash command to execute',
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
      return executeShell(command);
    },
  };

  const memory = getMemoryTools().map((t) => ({
    definition: t.definition,
    execute: t.execute,
  }));

  return [shell, ...memory];
}

export class ToolRegistry {
  private builtInTools: RegisteredTool[] = getBuiltInTools();

  /**
   * Loads all tools, optionally filtered to only the names in `allowedNames`.
   * When `allowedNames` is provided, only tools whose name is in the set are returned.
   */
  async loadTools(allowedNames?: Set<string>): Promise<{
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
    }

    logger.info(
      { total: definitions.length, filtered: !!allowedNames },
      'Tool registry loaded'
    );

    return { definitions, dispatch };
  }
}

export const toolRegistry = new ToolRegistry();
