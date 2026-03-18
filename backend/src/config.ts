import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(''),
  TELEGRAM_ALLOW_EMPTY_ALLOWLIST: z.coerce.boolean().default(false),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5:7b-instruct'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
  MCP_SERVERS_JSON: z.string().optional(),
  MCP_TOOL_POLICY_JSON: z.string().optional(),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  OLLAMA_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(10),
  SHELL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  TELEGRAM_SHOW_AGENT_TRACE: z.coerce.boolean().default(false),
  HA_MCP_BASE_URL: z.string().url().optional(),
  HA_MCP_API_KEY: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const formatted = parsedEnv.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${formatted}`);
}

const env = parsedEnv.data;

const allowedUserIds = env.ALLOWED_TELEGRAM_USER_IDS
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => Number.parseInt(entry, 10))
  .filter((entry) => Number.isInteger(entry));

export interface McpServerConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface McpToolPolicy {
  allowedTools?: string[];
  excludedTools?: string[];
  requireExplicitPrefixTools?: string[];
}

export interface McpToolPolicyConfig {
  default?: McpToolPolicy;
  servers?: Record<string, McpToolPolicy>;
}

function parseMcpServers(): McpServerConfig[] {
  if (env.MCP_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(env.MCP_SERVERS_JSON) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('MCP_SERVERS_JSON must be a JSON array');
      }

      return parsed.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new Error(`MCP server entry at index ${index} must be an object`);
        }
        const record = item as Record<string, unknown>;
        const name = String(record.name ?? '').trim();
        const baseUrl = String(record.baseUrl ?? '').trim();
        const apiKey = String(record.apiKey ?? '').trim();
        if (!name || !baseUrl || !apiKey) {
          throw new Error(`MCP server entry at index ${index} requires name, baseUrl, apiKey`);
        }
        return {
          name,
          baseUrl: baseUrl.replace(/\/$/, ''),
          apiKey,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid MCP_SERVERS_JSON: ${message}`);
    }
  }

  if (env.HA_MCP_BASE_URL && env.HA_MCP_API_KEY) {
    return [
      {
        name: 'home_assistant',
        baseUrl: env.HA_MCP_BASE_URL.replace(/\/$/, ''),
        apiKey: env.HA_MCP_API_KEY,
      },
    ];
  }

  return [];
}

const mcpServers = parseMcpServers();

function parseMcpToolPolicy(): McpToolPolicyConfig {
  if (!env.MCP_TOOL_POLICY_JSON) {
    return {};
  }

  try {
    const parsed = JSON.parse(env.MCP_TOOL_POLICY_JSON) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MCP_TOOL_POLICY_JSON must be an object');
    }
    return parsed as McpToolPolicyConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP_TOOL_POLICY_JSON: ${message}`);
  }
}

const mcpToolPolicy = parseMcpToolPolicy();

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedTelegramUserIds: new Set<number>(allowedUserIds),
  telegramAllowEmptyAllowlist: env.TELEGRAM_ALLOW_EMPTY_ALLOWLIST,
  ollamaBaseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
  ollamaModel: env.OLLAMA_MODEL,
  ollamaTimeoutMs: env.OLLAMA_TIMEOUT_MS,
  haMcpBaseUrl: env.HA_MCP_BASE_URL?.replace(/\/$/, ''),
  haMcpApiKey: env.HA_MCP_API_KEY,
  mcpServers,
  mcpToolPolicy,
  mcpTimeoutMs: env.MCP_TIMEOUT_MS,
  ollamaMaxToolCalls: env.OLLAMA_MAX_TOOL_CALLS,
  shellTimeoutMs: env.SHELL_TIMEOUT_MS,
  telegramShowAgentTrace: env.TELEGRAM_SHOW_AGENT_TRACE,
  logLevel: env.LOG_LEVEL,
};
