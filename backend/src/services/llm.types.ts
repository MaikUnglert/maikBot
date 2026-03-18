export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolName?: string;
}

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
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
