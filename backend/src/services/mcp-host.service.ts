import { config, McpServerConfig, McpToolPolicy } from '../config.js';
import { logger } from '../logger.js';

interface ToolResult {
  ok: boolean;
  output: string;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpToolsListResult {
  tools?: McpToolInfo[];
}

interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface ServerToolInfo extends McpToolInfo {
  server: string;
}

function applyPolicyFilter(tools: McpToolInfo[], policy?: McpToolPolicy): McpToolInfo[] {
  if (!policy) {
    return tools;
  }

  const allowed = policy.allowedTools ? new Set(policy.allowedTools) : null;
  const excluded = policy.excludedTools ? new Set(policy.excludedTools) : null;

  return tools.filter((tool) => {
    if (allowed && !allowed.has(tool.name)) {
      return false;
    }
    if (excluded && excluded.has(tool.name)) {
      return false;
    }
    return true;
  });
}

export class McpHostService {
  private requestId = 1;
  private toolsCache: { tools: ServerToolInfo[]; expiresAt: number } | null = null;

  private getServers(): McpServerConfig[] {
    return config.mcpServers;
  }

  private getServerPolicy(serverName: string): McpToolPolicy | undefined {
    return config.mcpToolPolicy.servers?.[serverName];
  }

  private getDefaultPolicy(): McpToolPolicy | undefined {
    return config.mcpToolPolicy.default;
  }

  isConfigured(): boolean {
    return this.getServers().length > 0;
  }

  private getMcpEndpoint(server: McpServerConfig): string {
    if (server.url) return server.url;
    const base = server.baseUrl ?? '';
    if (base.endsWith('/api/mcp')) return base;
    return `${base}/api/mcp`;
  }

  private async callJsonRpc<T>(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const endpoint = this.getMcpEndpoint(server);
    const id = this.requestId++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.mcpTimeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (server.apiKey) {
      headers.Authorization = `Bearer ${server.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`MCP request timed out after ${config.mcpTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    let data: JsonRpcResponse<T>;

    if (contentType.includes('text/event-stream')) {
      data = await this.parseSseResponse<T>(response);
    } else {
      data = (await response.json()) as JsonRpcResponse<T>;
    }

    if (data.error) {
      throw new Error(`${data.error.code}: ${data.error.message}`);
    }
    if (!data.result) {
      throw new Error('No JSON-RPC result returned by MCP server');
    }

    return data.result;
  }

  private async parseSseResponse<T>(response: Response): Promise<JsonRpcResponse<T>> {
    const text = await response.text();
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const json = line.slice(6).trim();
        if (json) {
          return JSON.parse(json) as JsonRpcResponse<T>;
        }
      }
    }
    throw new Error('No valid data event in SSE response');
  }

  async listTools(forceRefresh = false): Promise<ServerToolInfo[]> {
    const now = Date.now();
    if (!forceRefresh && this.toolsCache && now < this.toolsCache.expiresAt) {
      return this.toolsCache.tools;
    }

    const servers = this.getServers();
    const tools: ServerToolInfo[] = [];

    for (const server of servers) {
      try {
        const result = await this.callJsonRpc<McpToolsListResult>(server, 'tools/list', {});
        let filtered = applyPolicyFilter(result.tools ?? [], this.getDefaultPolicy());
        filtered = applyPolicyFilter(filtered, this.getServerPolicy(server.name));
        for (const tool of filtered) {
          tools.push({
            ...tool,
            server: server.name,
          });
        }
      } catch (error) {
        logger.error({ err: error, server: server.name }, 'Failed to list MCP tools for server');
      }
    }

    this.toolsCache = { tools, expiresAt: now + 30_000 };
    return tools;
  }

  private formatToolCallOutput(result: McpToolCallResult): string {
    const texts = (result.content ?? [])
      .map((item) => item.text?.trim())
      .filter((text): text is string => Boolean(text));

    if (texts.length === 0) {
      return result.isError ? 'Tool call returned an error without details.' : 'Tool call succeeded.';
    }
    return texts.join('\n');
  }

  private requiresExplicitPrefix(toolName: string, serverName: string): boolean {
    const defaultPolicy = this.getDefaultPolicy();
    const serverPolicy = this.getServerPolicy(serverName);
    const defaultSet = new Set(defaultPolicy?.requireExplicitPrefixTools ?? []);
    const serverSet = new Set(serverPolicy?.requireExplicitPrefixTools ?? []);
    return defaultSet.has(toolName) || serverSet.has(toolName);
  }

  private async callToolOnServer(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      const startedAt = Date.now();
      logger.info({ server: server.name, tool: toolName, args }, 'Calling MCP tool');
      const result = await this.callJsonRpc<McpToolCallResult>(server, 'tools/call', {
        name: toolName,
        arguments: args,
      });
      const output = this.formatToolCallOutput(result);
      logger.info(
        {
          server: server.name,
          tool: toolName,
          isError: result.isError ?? false,
          durationMs: Date.now() - startedAt,
          outputPreview: output.slice(0, 300),
        },
        'MCP tool call completed'
      );
      return {
        ok: !(result.isError ?? false),
        output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, server: server.name, tool: toolName }, 'MCP tool call failed');
      return {
        ok: false,
        output: `MCP call failed on server "${server.name}": ${message}`,
      };
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: { server?: string; explicitUserCommand?: boolean }
  ): Promise<ToolResult> {
    const servers = this.getServers();
    if (servers.length === 0) {
      return { ok: false, output: 'No MCP server configured.' };
    }

    const explicit = options?.explicitUserCommand ?? false;

    if (options?.server) {
      const server = servers.find((entry) => entry.name === options.server);
      if (!server) {
        return { ok: false, output: `Unknown MCP server "${options.server}".` };
      }
      if (!explicit && this.requiresExplicitPrefix(toolName, server.name)) {
        return {
          ok: false,
          output: `Tool "${toolName}" on server "${server.name}" requires explicit /mcp confirmation.`,
        };
      }
      return this.callToolOnServer(server, toolName, args);
    }

    const tools = await this.listTools();
    const providers = tools.filter((tool) => tool.name === toolName).map((tool) => tool.server);
    if (providers.length === 0) {
      return { ok: false, output: `Tool "${toolName}" is not available on any configured MCP server.` };
    }
    if (providers.length > 1) {
      return {
        ok: false,
        output: `Tool "${toolName}" is available on multiple servers (${providers.join(', ')}). Please specify a server.`,
      };
    }

    const selected = servers.find((server) => server.name === providers[0]);
    if (!selected) {
      return { ok: false, output: `Selected MCP server "${providers[0]}" is not configured.` };
    }
    if (!explicit && this.requiresExplicitPrefix(toolName, selected.name)) {
      return {
        ok: false,
        output: `Tool "${toolName}" on server "${selected.name}" requires explicit /mcp confirmation.`,
      };
    }
    return this.callToolOnServer(selected, toolName, args);
  }

  async runTool(instruction: string): Promise<ToolResult> {
    const trimmed = instruction.trim();
    if (!trimmed || trimmed === 'tools' || trimmed === 'help') {
      const tools = await this.listTools();
      const lines = tools.map((tool) =>
        tool.description
          ? `- [${tool.server}] ${tool.name}: ${tool.description}`
          : `- [${tool.server}] ${tool.name}`
      );
      return {
        ok: true,
        output: lines.length > 0 ? `Available tools:\n${lines.join('\n')}` : 'No MCP tools available.',
      };
    }

    return {
      ok: false,
      output: 'Direct free-form runTool mode is deprecated. Use callTool with tool+arguments.',
    };
  }
}

export const mcpHostService = new McpHostService();
