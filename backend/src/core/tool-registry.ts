import { mcpHostService } from '../services/mcp-host.service.js';
import { executeShell } from './tools/shell.js';
import { logger } from '../logger.js';
import type { OllamaToolDefinition } from '../services/ollama.service.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

interface RegisteredTool {
  definition: OllamaToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}

/**
 * Normalizes an MCP inputSchema into a safe JSON Schema object
 * suitable for Ollama's tool parameters field.
 */
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

/**
 * Built-in tools that are always available regardless of MCP configuration.
 */
function getBuiltInTools(): RegisteredTool[] {
  return [
    {
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
    },
  ];
}

export class ToolRegistry {
  private builtInTools: RegisteredTool[] = getBuiltInTools();

  /**
   * Loads all available tools: MCP tools (policy-filtered, cached)
   * merged with built-in tools. Returns Ollama tool definitions
   * and a dispatch map.
   */
  async loadTools(): Promise<{
    definitions: OllamaToolDefinition[];
    dispatch: Map<string, (args: Record<string, unknown>) => Promise<ToolExecResult>>;
  }> {
    const definitions: OllamaToolDefinition[] = [];
    const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<ToolExecResult>>();

    // MCP tools
    if (mcpHostService.isConfigured()) {
      const mcpTools = await mcpHostService.listTools();
      for (const tool of mcpTools) {
        const name = tool.name;

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

    // Built-in tools
    for (const tool of this.builtInTools) {
      const name = tool.definition.function.name;
      definitions.push(tool.definition);
      dispatch.set(name, tool.execute);
    }

    logger.info(
      { mcpTools: definitions.length - this.builtInTools.length, builtInTools: this.builtInTools.length },
      'Tool registry loaded'
    );

    return { definitions, dispatch };
  }
}

export const toolRegistry = new ToolRegistry();
