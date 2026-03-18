import { config } from '../config.js';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

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

export interface ChatResult {
  content: string;
  toolCalls: OllamaToolCall[];
}

export class OllamaService {
  /**
   * Simple text generation (system + user prompt, no tools).
   * Kept for plain chat without tool calling.
   */
  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    const result = await this.chatWithTools(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      []
    );
    return result.content;
  }

  /**
   * Native Ollama tool-calling chat. Sends messages + tool definitions,
   * returns the assistant content and any tool_calls the model requested.
   */
  async chatWithTools(
    messages: OllamaMessage[],
    tools: OllamaToolDefinition[]
  ): Promise<ChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: config.ollamaModel,
        messages,
        stream: false,
        think: false,
      };

      if (tools.length > 0) {
        body.tools = tools;
      }

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

      const toolCalls: OllamaToolCall[] = (data.message.tool_calls ?? []).map(
        (tc) => ({
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments ?? {},
          },
        })
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
