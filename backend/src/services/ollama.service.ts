import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LlmProvider, LlmMessage, ToolDefinition, ToolCall, ChatResult } from './llm.types.js';

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
}

export class OllamaService implements LlmProvider {
  readonly name = 'ollama';

  async chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: config.ollamaModel,
        messages: messages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role, content: m.content };
          if (m.toolCalls) msg.tool_calls = m.toolCalls;
          if (m.toolName) msg.tool_name = m.toolName;
          return msg;
        }),
        stream: false,
        think: false,
      };

      if (tools.length > 0) {
        body.tools = tools;
      }

      const startedAt = Date.now();
      logger.info(
        { model: body.model, toolCount: tools.length, msgCount: messages.length },
        'Sending request to Ollama'
      );

      const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama error ${response.status}: ${text}`);
      }

      const data = (await response.json()) as OllamaChatResponse;

      const toolCalls: ToolCall[] = (data.message.tool_calls ?? []).map((tc) => ({
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments ?? {},
        },
      }));

      logger.info(
        {
          durationMs: Date.now() - startedAt,
          contentLen: (data.message.content ?? '').length,
          toolCallCount: toolCalls.length,
        },
        'Ollama response received'
      );

      return {
        content: data.message.content ?? '',
        toolCalls,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${config.ollamaTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${config.ollamaBaseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const ollamaService = new OllamaService();
