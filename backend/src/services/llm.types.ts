export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolName?: string;
  /** OpenAI-style tool round-trip (required when multiple tools run in one turn) */
  toolCallId?: string;
}

export interface ToolCall {
  /** Provider-assigned id (OpenAI/NVIDIA); synthesized when missing */
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
  /** Gemini 3 thought signature — must be preserved and sent back */
  thoughtSignature?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<ChatResult>;
  healthCheck(): Promise<boolean>;
  readonly name: string;
}
