import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmProvider, LlmMessage, ToolDefinition, ToolCall, ChatResult } from './llm.types.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
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

      case 'user':
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
        break;

      case 'assistant': {
        const parts: GeminiPart[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: { name: tc.function.name, args: tc.function.arguments },
            });
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

function toGeminiFunctionDeclarations(tools: ToolDefinition[]) {
  if (tools.length === 0) return undefined;

  return [
    {
      function_declarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

function parseGeminiResponse(data: GeminiResponse): ChatResult {
  if (data.error) {
    throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
  }

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if (part.text) {
      content += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        function: {
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        },
      });
    }
  }

  return { content, toolCalls };
}

export class GeminiService implements LlmProvider {
  readonly name = 'gemini';

  async chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const apiKey = config.geminiApiKey;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const model = config.geminiModel;
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`;

    const { systemInstruction, contents } = toGeminiContents(messages);
    const geminiTools = toGeminiFunctionDeclarations(tools);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.system_instruction = systemInstruction;
    if (geminiTools) body.tools = geminiTools;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.geminiTimeoutMs);

    try {
      const startedAt = Date.now();
      logger.info(
        { model, toolCount: tools.length, msgCount: messages.length },
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
