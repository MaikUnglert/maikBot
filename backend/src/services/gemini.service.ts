import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmProvider, LlmMessage, ToolDefinition, ToolCall, ChatResult } from './llm.types.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message: string; code: number };
}

function toGeminiContents(messages: LlmMessage[]): {
  systemInstruction: { parts: GeminiPart[] } | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: { parts: GeminiPart[] } | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        systemInstruction = { parts: [{ text: msg.content }] };
        break;

      case 'user': {
        const parts: GeminiPart[] = [];
        if (msg.imageAttachment) {
          parts.push({
            inlineData: {
              mimeType: msg.imageAttachment.mimeType,
              data: msg.imageAttachment.base64,
            },
          });
        }
        parts.push({ text: msg.content || 'What do you see in this image?' });
        contents.push({ role: 'user', parts });
        break;
      }

      case 'assistant': {
        const parts: GeminiPart[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const fcPart: GeminiPart = {
              functionCall: { name: tc.function.name, args: tc.function.arguments },
            };
            if (tc.thoughtSignature) {
              fcPart.thoughtSignature = tc.thoughtSignature;
            }
            parts.push(fcPart);
          }
        }
        if (parts.length > 0) contents.push({ role: 'model', parts });
        break;
      }

      case 'tool':
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.toolName ?? 'unknown',
                response: { result: msg.content },
              },
            },
          ],
        });
        break;
    }
  }

  return { systemInstruction, contents };
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  '$schema',
  'default',
  'title',
]);

function sanitizeSchema(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeSchema);
  if (obj && typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (!UNSUPPORTED_SCHEMA_KEYS.has(key)) {
        cleaned[key] = sanitizeSchema(val);
      }
    }
    return cleaned;
  }
  return obj;
}

function toGeminiFunctionDeclarations(tools: ToolDefinition[]) {
  if (tools.length === 0) return undefined;

  return [
    {
      function_declarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: sanitizeSchema(t.function.parameters),
      })),
    },
  ];
}

function parseGeminiResponse(data: GeminiResponse): ChatResult {
  if (data.error) {
    throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
  }

  if (!data.candidates?.length) {
    const block = data.promptFeedback?.blockReason ?? 'unknown';
    logger.warn({ promptFeedback: data.promptFeedback }, 'Gemini returned no candidates');
    return {
      content: `The model did not return an answer (blocked or empty: ${block}). Try rephrasing.`,
      toolCalls: [],
    };
  }

  const parts = data.candidates[0]?.content?.parts ?? [];
  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if (part.text) {
      content += part.text;
    }
    if (part.functionCall) {
      const tc: ToolCall = {
        function: {
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        },
      };
      if (part.thoughtSignature) {
        tc.thoughtSignature = part.thoughtSignature;
      }
      toolCalls.push(tc);
    }
  }

  return { content, toolCalls };
}

export class GeminiService implements LlmProvider {
  readonly name = 'gemini';

  async chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const apiKey = config.geminiApiKey;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const { systemInstruction, contents } = toGeminiContents(messages);
    const geminiTools = toGeminiFunctionDeclarations(tools);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.system_instruction = systemInstruction;
    if (geminiTools) body.tools = geminiTools;

    const primaryModel = config.geminiModel;
    const fallbackModel = config.geminiFallbackModel;

    try {
      return await this.executeChat(primaryModel, apiKey, body, tools.length, messages.length);
    } catch (error) {
      if (
        fallbackModel &&
        error instanceof Error &&
        error.message.includes('Gemini HTTP 429') &&
        primaryModel !== fallbackModel
      ) {
        logger.warn(
          { primaryModel, fallbackModel },
          'Rate limit exceeded (429) on primary model. Retrying with fallback model.'
        );
        return await this.executeChat(fallbackModel, apiKey, body, tools.length, messages.length);
      }
      throw error;
    }
  }

  private async executeChat(
    model: string,
    apiKey: string,
    body: Record<string, unknown>,
    toolCount: number,
    msgCount: number
  ): Promise<ChatResult> {
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.geminiTimeoutMs);

    try {
      const startedAt = Date.now();
      logger.info(
        { model, toolCount, msgCount },
        'Sending request to Gemini'
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini HTTP ${response.status}: ${text}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const result = parseGeminiResponse(data);

      logger.info(
        {
          durationMs: Date.now() - startedAt,
          contentLen: result.content.length,
          toolCallCount: result.toolCalls.length,
        },
        'Gemini response received'
      );

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Gemini request timed out after ${config.geminiTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!config.geminiApiKey) return false;
    try {
      const url = `${GEMINI_BASE}/models/${config.geminiModel}?key=${config.geminiApiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const geminiService = new GeminiService();
