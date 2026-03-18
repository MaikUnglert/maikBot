import { ollamaService } from '../services/ollama.service.js';
import { mcpHostService } from '../services/mcp-host.service.js';
import { toolRegistry } from './tool-registry.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { OllamaMessage, OllamaToolDefinition } from '../services/ollama.service.js';

const SYSTEM_PROMPT = `/no_think
You are MaikBot, a local AI assistant running on a home server.
Rules:
1) Respond briefly and clearly in German unless the user asks for another language.
2) You have access to tools (smart home, shell, etc.). Use them when the user's request requires it.
3) Do not invent tool results or device states. Only report what tools return.
4) If a tool call fails, you may retry with different arguments or explain the error.
5) For shell commands, prefer concise output (e.g. use flags like -h, --no-pager, head/tail).
6) On errors, provide concrete next steps.`;

export interface AssistantResponse {
  reply: string;
  trace: string[];
}

export class Assistant {
  /**
   * Main entry point for every user message.
   * Runs the native Ollama tool-calling loop:
   * 1) Load tools from registry (MCP + built-in)
   * 2) Send messages + tools to Ollama
   * 3) While model returns tool_calls (up to max): execute, feed results back
   * 4) Return final text
   */
  async handleTextWithTrace(input: string): Promise<AssistantResponse> {
    const trimmed = input.trim();
    const trace: string[] = [];

    if (!trimmed) {
      return { reply: 'Bitte sende eine Nachricht.', trace };
    }

    // /mcp tools — debug command to list available tools
    if (trimmed.startsWith('/mcp ')) {
      const instruction = trimmed.replace(/^\/mcp\s+/i, '').trim();
      if (instruction === 'tools' || instruction === 'help') {
        const result = await mcpHostService.runTool('tools');
        trace.push('action: tools_list');
        return { reply: result.output, trace };
      }
    }

    // Load all tools (MCP + built-in)
    const { definitions, dispatch } = await toolRegistry.loadTools();
    trace.push(`tools_loaded: ${definitions.length}`);

    // Build initial messages
    const messages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: trimmed },
    ];

    // Tool-calling loop
    let callCount = 0;
    const maxCalls = config.ollamaMaxToolCalls;

    while (true) {
      const result = await ollamaService.chatWithTools(messages, definitions);

      // No tool calls — final response
      if (result.toolCalls.length === 0) {
        trace.push('execution_path: final');
        const reply = result.content || 'Keine Antwort vom Modell.';
        return { reply, trace };
      }

      // Append the assistant message (with tool_calls) to conversation
      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls,
      });

      // Execute each tool call
      for (const tc of result.toolCalls) {
        callCount++;
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;

        trace.push(`tool_call[${callCount}]: ${toolName} args=${JSON.stringify(toolArgs)}`);
        logger.info({ toolName, toolArgs, callCount }, 'Executing tool call');

        const handler = dispatch.get(toolName);
        let output: string;

        if (!handler) {
          output = `Tool "${toolName}" is not available.`;
          trace.push(`tool_result[${callCount}]: error (unknown tool)`);
        } else {
          try {
            const execResult = await handler(toolArgs);
            output = execResult.output;
            trace.push(
              `tool_result[${callCount}]: ${execResult.ok ? 'ok' : 'error'} ${output.slice(0, 180)}`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output = `Tool execution error: ${message}`;
            trace.push(`tool_result[${callCount}]: exception ${message.slice(0, 180)}`);
            logger.error({ err: error, toolName }, 'Tool execution threw');
          }
        }

        // Append tool result to conversation
        messages.push({
          role: 'tool',
          content: output,
          tool_name: toolName,
        });
      }

      // Safety: max tool calls reached — force a final response without tools
      if (callCount >= maxCalls) {
        trace.push(`max_tool_calls_reached: ${maxCalls}`);
        logger.warn({ callCount, maxCalls }, 'Max tool calls reached, forcing final response');
        const finalResult = await ollamaService.chatWithTools(messages, []);
        return {
          reply: finalResult.content || 'Tool-Call-Limit erreicht. Bitte versuche es erneut.',
          trace,
        };
      }
    }
  }

  async handleText(input: string): Promise<string> {
    const result = await this.handleTextWithTrace(input);
    return result.reply;
  }
}

export const assistant = new Assistant();
