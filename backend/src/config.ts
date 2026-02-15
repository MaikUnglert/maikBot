import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(''),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5:7b-instruct'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  HA_MCP_BASE_URL: z.string().url().optional(),
  HA_MCP_API_KEY: z.string().optional(),
  HA_MCP_TOOL_NAME: z.string().default('home_assistant'),
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

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedTelegramUserIds: new Set<number>(allowedUserIds),
  ollamaBaseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
  ollamaModel: env.OLLAMA_MODEL,
  ollamaTimeoutMs: env.OLLAMA_TIMEOUT_MS,
  haMcpBaseUrl: env.HA_MCP_BASE_URL?.replace(/\/$/, ''),
  haMcpApiKey: env.HA_MCP_API_KEY,
  haMcpToolName: env.HA_MCP_TOOL_NAME,
  logLevel: env.LOG_LEVEL,
};
