import 'dotenv/config';
import { z } from 'zod';

const booleanString = z
  .string()
  .transform((val) => val.toLowerCase() === 'true' || val === '1')
  .pipe(z.boolean());

const llmProviderEnum = z.enum(['ollama', 'gemini', 'nvidia']).default('ollama');

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(''),
  TELEGRAM_ALLOW_EMPTY_ALLOWLIST: booleanString.default('false'),

  LLM_PROVIDER: llmProviderEnum,

  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5:7b-instruct'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  GEMINI_FALLBACK_MODEL: z.string().optional(),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_MODEL: z.string().min(1).default('moonshotai/kimi-k2.5'),
  NVIDIA_MAX_TOKENS: z.coerce.number().int().positive().default(16384),
  NVIDIA_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  MCP_SERVERS_JSON: z.string().optional(),
  MCP_TOOL_POLICY_JSON: z.string().optional(),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  LLM_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(10),
  SHELL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  TELEGRAM_SHOW_AGENT_TRACE: booleanString.default('false'),
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
  url?: string;
  baseUrl?: string;
  apiKey?: string;
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
  const raw = env.MCP_SERVERS_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('MCP_SERVERS_JSON must be a JSON array');
      }

      return parsed.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new Error(`MCP server entry at index ${index} must be an object`);
        }
        const record = item as Record<string, unknown>;
        const name = String(record.name ?? '').trim();
        const url = record.url ? String(record.url).trim().replace(/\/$/, '') : undefined;
        const baseUrl = record.baseUrl ? String(record.baseUrl).trim().replace(/\/$/, '') : undefined;
        const apiKey = record.apiKey ? String(record.apiKey).trim() : undefined;
        if (!name || (!url && !baseUrl)) {
          throw new Error(`MCP server entry at index ${index} requires name and either url or baseUrl`);
        }
        return { name, url, baseUrl, apiKey };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[config] Invalid MCP_SERVERS_JSON, starting without MCP: ${message}`);
      return [];
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

export type LlmProviderName = 'ollama' | 'gemini' | 'nvidia';

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedTelegramUserIds: new Set<number>(allowedUserIds),
  telegramAllowEmptyAllowlist: env.TELEGRAM_ALLOW_EMPTY_ALLOWLIST,

  defaultLlmProvider: env.LLM_PROVIDER as LlmProviderName,

  ollamaBaseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
  ollamaModel: env.OLLAMA_MODEL,
  ollamaTimeoutMs: env.OLLAMA_TIMEOUT_MS,

  geminiApiKey: env.GEMINI_API_KEY,
  geminiModel: env.GEMINI_MODEL,
  geminiFallbackModel: env.GEMINI_FALLBACK_MODEL,
  geminiTimeoutMs: env.GEMINI_TIMEOUT_MS,

  nvidiaApiKey: env.NVIDIA_API_KEY,
  nvidiaModel: env.NVIDIA_MODEL,
  nvidiaMaxTokens: env.NVIDIA_MAX_TOKENS,
  nvidiaTimeoutMs: env.NVIDIA_TIMEOUT_MS,

  haMcpBaseUrl: env.HA_MCP_BASE_URL?.replace(/\/$/, ''),
  haMcpApiKey: env.HA_MCP_API_KEY,
  mcpServers,
  mcpToolPolicy,
  mcpTimeoutMs: env.MCP_TIMEOUT_MS,
  llmMaxToolCalls: env.LLM_MAX_TOOL_CALLS,
  shellTimeoutMs: env.SHELL_TIMEOUT_MS,
  telegramShowAgentTrace: env.TELEGRAM_SHOW_AGENT_TRACE,
  logLevel: env.LOG_LEVEL,
};
