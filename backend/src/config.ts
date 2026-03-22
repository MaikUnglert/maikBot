import 'dotenv/config';
import path from 'node:path';
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
  /** Vision model for screenshot analysis (llava, llava:13b, etc.). Used when Gemini is not configured. */
  OLLAMA_VISION_MODEL: z.string().min(1).default('llava'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  GEMINI_FALLBACK_MODEL: z.string().optional(),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_MODEL: z.string().min(1).default('moonshotai/kimi-k2.5'),
  NVIDIA_MAX_TOKENS: z.coerce.number().int().positive().default(16384),
  NVIDIA_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  /** Extra attempts after HTTP 429 (fixed pause between each retry). */
  NVIDIA_429_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  NVIDIA_429_BACKOFF_MS: z.coerce.number().int().positive().default(1000),

  MCP_SERVERS_JSON: z.string().optional(),
  MCP_TOOL_POLICY_JSON: z.string().optional(),
  MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  /** Max tool calls per turn. 0 = unlimited. */
  LLM_MAX_TOOL_CALLS: z.coerce.number().int().min(0).default(0),
  SHELL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  TELEGRAM_SHOW_AGENT_TRACE: booleanString.default('false'),
  /** Skip triage LLM call; load all tool categories in one phase (fewer API calls, larger tool schema). */
  LLM_SKIP_TRIAGE: booleanString.default('false'),
  /** Heuristic: short on/off-style commands skip triage and use search+control only (saves 1 call + smaller schema). */
  LLM_HA_FAST_PATH: booleanString.default('true'),

  /** Directory for domain memory files (*.md), e.g. entity nicknames. Default: <cwd>/data/memory */
  MEMORY_DATA_DIR: z.string().optional(),

  /** Heartbeat: interval in seconds when work is pending (tasks due soon, running Gemini jobs). Default: 60. */
  HEARTBEAT_ACTIVE_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  /** Heartbeat: interval in seconds when idle (no tasks, no running jobs). Default: 1800 (30 min). */
  HEARTBEAT_IDLE_INTERVAL_SEC: z.coerce.number().int().positive().default(1800),
  /** Directory for scheduled tasks JSON. Default: <cwd>/data/scheduler */
  SCHEDULER_DATA_DIR: z.string().optional(),

  /** Directory for Gemini CLI job state. Default: <cwd>/data/jobs */
  JOBS_DATA_DIR: z.string().optional(),
  /** Directory for async shell job output. Default: <cwd>/data/shell-jobs */
  SHELL_JOBS_DATA_DIR: z.string().optional(),
  /** Allowed workspace root for Gemini CLI (must be absolute path). Default: process.cwd() */
  GEMINI_CLI_WORKSPACE_ROOT: z.string().optional(),

  /** Chat session max age in ms before pruning. Default: 24h (for long-running Gemini CLI jobs). */
  CHAT_MAX_AGE_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),

  HA_MCP_BASE_URL: z.string().url().optional(),
  HA_MCP_API_KEY: z.string().optional(),

  /** WhatsApp (Baileys): enable channel. Default false. */
  WHATSAPP_ENABLED: booleanString.default('false'),
  /** Auth dir for Baileys session. Default: <cwd>/data/whatsapp-auth */
  WHATSAPP_AUTH_DIR: z.string().optional(),
  /** Comma-separated E.164 numbers (e.g. +491234567890) or * for open. Empty = require allowlist. */
  WHATSAPP_ALLOWED_FROM: z.string().default(''),
  /** Allow all senders when allowlist is empty (dangerous). Default false. */
  WHATSAPP_ALLOW_EMPTY_ALLOWLIST: booleanString.default('false'),
  /** Print QR code in terminal for first-time linking. Default true. */
  WHATSAPP_PRINT_QR: booleanString.default('true'),
  /** Allow group chats (group participants must be in allowlist). Default false. */
  WHATSAPP_GROUPS_ENABLED: booleanString.default('false'),
  /** Only process "Message to yourself" (self-chat); ignore all other senders. Default false. */
  WHATSAPP_SELF_ONLY: booleanString.default('false'),

  /** Paperless-ngx: URL (e.g. http://paperless:8000). Enables document classification webhook. */
  PAPERLESS_URL: z.string().url().optional(),
  /** Paperless-ngx: API token for authentication. */
  PAPERLESS_TOKEN: z.string().optional(),
  /** Paperless classifier: restrict to existing tags/correspondents/doc types (no auto-create). Default false. */
  PAPERLESS_RESTRICT_TO_EXISTING: booleanString.default('false'),
  /** Paperless webhook: port for HTTP server. Default 3080. */
  PAPERLESS_CLASSIFY_PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  /** Paperless webhook: optional secret for Authorization: Bearer <secret>. */
  PAPERLESS_CLASSIFY_WEBHOOK_SECRET: z.string().optional(),

  /** Scan: backend. "hp-webscan" (HP printer WebScan), "scanimage" (SANE), or "none". */
  SCAN_BACKEND: z.enum(['hp-webscan', 'scanimage', 'none']).default('none'),
  /** Scan: HP printer IP for hp-webscan (WebScan must be enabled in printer EWS). */
  SCAN_HP_PRINTER_IP: z.string().optional(),
  /** Scan: SANE device string for scanimage (e.g. "hpaio:/net/HP_..."). Optional. */
  SCAN_SANE_DEVICE: z.string().optional(),
  /** Scan: temp directory. Default: data/scan */
  SCAN_DATA_DIR: z.string().optional(),

  /** Browser automation: enable Playwright-based web browsing. Default false. */
  BROWSER_ENABLED: booleanString.default('false'),
  /** Run browser headless (no visible window). Default true. */
  BROWSER_HEADLESS: booleanString.default('true'),
  /** Timeout for page operations in ms. Default 30000. */
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

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

function resolveMemoryDataDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.resolve(process.cwd(), 'data', 'memory');
}

function resolveSchedulerDataDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.resolve(process.cwd(), 'data', 'scheduler');
}

function resolveJobsDataDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.resolve(process.cwd(), 'data', 'jobs');
}

function resolveShellJobsDataDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.resolve(process.cwd(), 'data', 'shell-jobs');
}

function resolveGeminiCliWorkspace(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return process.cwd();
}

function resolveWhatsAppAuthDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.resolve(process.cwd(), 'data', 'whatsapp-auth');
}

function resolveScanDataDir(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed) return path.resolve(trimmed);
  return path.resolve(process.cwd(), 'data', 'scan');
}

function parseWhatsAppAllowedFrom(raw: string): Set<string> {
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);
  return new Set(entries);
}

export type LlmProviderName = 'ollama' | 'gemini' | 'nvidia';

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedTelegramUserIds: new Set<number>(allowedUserIds),
  telegramAllowEmptyAllowlist: env.TELEGRAM_ALLOW_EMPTY_ALLOWLIST,

  defaultLlmProvider: env.LLM_PROVIDER as LlmProviderName,

  ollamaBaseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
  ollamaModel: env.OLLAMA_MODEL,
  ollamaVisionModel: env.OLLAMA_VISION_MODEL,
  ollamaTimeoutMs: env.OLLAMA_TIMEOUT_MS,

  geminiApiKey: env.GEMINI_API_KEY,
  geminiModel: env.GEMINI_MODEL,
  geminiFallbackModel: env.GEMINI_FALLBACK_MODEL,
  geminiTimeoutMs: env.GEMINI_TIMEOUT_MS,

  nvidiaApiKey: env.NVIDIA_API_KEY,
  nvidiaModel: env.NVIDIA_MODEL,
  nvidiaMaxTokens: env.NVIDIA_MAX_TOKENS,
  nvidiaTimeoutMs: env.NVIDIA_TIMEOUT_MS,
  nvidia429MaxRetries: env.NVIDIA_429_MAX_RETRIES,
  nvidia429BackoffMs: env.NVIDIA_429_BACKOFF_MS,

  haMcpBaseUrl: env.HA_MCP_BASE_URL?.replace(/\/$/, ''),
  haMcpApiKey: env.HA_MCP_API_KEY,
  mcpServers,
  mcpToolPolicy,
  mcpTimeoutMs: env.MCP_TIMEOUT_MS,
  llmMaxToolCalls: env.LLM_MAX_TOOL_CALLS,
  shellTimeoutMs: env.SHELL_TIMEOUT_MS,
  telegramShowAgentTrace: env.TELEGRAM_SHOW_AGENT_TRACE,
  llmSkipTriage: env.LLM_SKIP_TRIAGE,
  llmHaFastPath: env.LLM_HA_FAST_PATH,
  memoryDataDir: resolveMemoryDataDir(env.MEMORY_DATA_DIR),
  heartbeatActiveIntervalSec: env.HEARTBEAT_ACTIVE_INTERVAL_SEC,
  heartbeatIdleIntervalSec: env.HEARTBEAT_IDLE_INTERVAL_SEC,
  schedulerDataDir: resolveSchedulerDataDir(env.SCHEDULER_DATA_DIR),
  jobsDataDir: resolveJobsDataDir(env.JOBS_DATA_DIR),
  shellJobsDataDir: resolveShellJobsDataDir(env.SHELL_JOBS_DATA_DIR),
  geminiCliWorkspaceRoot: resolveGeminiCliWorkspace(env.GEMINI_CLI_WORKSPACE_ROOT),
  chatMaxAgeMs: env.CHAT_MAX_AGE_MS,
  logLevel: env.LOG_LEVEL,

  whatsappEnabled: env.WHATSAPP_ENABLED,
  whatsappAuthDir: resolveWhatsAppAuthDir(env.WHATSAPP_AUTH_DIR),
  whatsappAllowedFrom: parseWhatsAppAllowedFrom(env.WHATSAPP_ALLOWED_FROM),
  whatsappAllowEmptyAllowlist: env.WHATSAPP_ALLOW_EMPTY_ALLOWLIST,
  whatsappPrintQR: env.WHATSAPP_PRINT_QR,
  whatsappGroupsEnabled: env.WHATSAPP_GROUPS_ENABLED,
  whatsappSelfOnly: env.WHATSAPP_SELF_ONLY,

  browserEnabled: env.BROWSER_ENABLED,
  browserHeadless: env.BROWSER_HEADLESS,
  browserTimeoutMs: env.BROWSER_TIMEOUT_MS,

  paperlessUrl: env.PAPERLESS_URL ? env.PAPERLESS_URL.replace(/\/$/, '') : undefined,
  paperlessToken: env.PAPERLESS_TOKEN,
  paperlessRestrictToExistingTags: env.PAPERLESS_RESTRICT_TO_EXISTING,
  paperlessRestrictToExistingCorrespondents: env.PAPERLESS_RESTRICT_TO_EXISTING,
  paperlessRestrictToExistingDocTypes: env.PAPERLESS_RESTRICT_TO_EXISTING,
  paperlessClassifyPort: env.PAPERLESS_CLASSIFY_PORT,
  paperlessClassifyWebhookSecret: env.PAPERLESS_CLASSIFY_WEBHOOK_SECRET?.trim() || undefined,

  scanBackend: env.SCAN_BACKEND,
  scanHpPrinterIp: env.SCAN_HP_PRINTER_IP?.trim(),
  scanSaneDevice: env.SCAN_SANE_DEVICE?.trim(),
  scanDataDir: resolveScanDataDir(env.SCAN_DATA_DIR),
};
