import { llmService } from '../services/llm.service.js';
import { mcpHostService } from '../services/mcp-host.service.js';
import { toolRegistry } from './tool-registry.js';
import { chatHistory } from './chat-history.js';
import { config, type LlmProviderName } from '../config.js';
import { logger } from '../logger.js';
import type { LlmMessage, ToolDefinition } from '../services/llm.types.js';

const SYSTEM_PROMPT = `You are MaikBot, a local AI assistant running on a home server.
Rules:
1) Respond briefly and clearly in German unless the user asks for another language.
2) You have access to tools (smart home, shell, etc.). Use them when the user's request requires it.
3) Do not invent tool results or device states. Only report what tools return.
4) If a tool call fails with a name/match error, call GetLiveContext first to discover the correct entity names, then retry with the correct name. Do NOT give up after the first failed attempt.
5) For shell commands, prefer concise output (e.g. use flags like -h, --no-pager, head/tail).
6) On errors, provide concrete next steps.`;

export interface AssistantResponse {
  reply: string;
  trace: string[];
}

export class Assistant {
  async handleTextWithTrace(chatId: number, input: string): Promise<AssistantResponse> {
    const trimmed = input.trim();
    const trace: string[] = [];

    if (!trimmed) {
      return { reply: 'Bitte sende eine Nachricht.', trace };
    }

    // /model — switch or show LLM provider
    if (trimmed.startsWith('/model')) {
      return this.handleModelCommand(trimmed, trace);
    }

    // /clear — reset chat history
    if (trimmed === '/clear') {
      chatHistory.clear(chatId);
      trace.push('action: history_cleared');
      return { reply: 'Chat-Verlauf gelöscht.', trace };
    }

    // /status — show chat stats
    if (trimmed === '/status') {
      const stats = chatHistory.getStats(chatId);
      trace.push('action: status');
      return {
        reply: `Modell: ${llmService.modelLabel}\nNachrichten im Kontext: ${stats.messageCount}\nGeschätzte Tokens: ${stats.estimatedTokens}`,
        trace,
      };
    }

    // /mcp tools — debug command
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
    trace.push(`provider: ${llmService.modelLabel}`);
    trace.push(`tools_loaded: ${definitions.length}`);

    // Build messages: system + history + current user message
    const history = chatHistory.getHistory(chatId);
    trace.push(`history_messages: ${history.length}`);

    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: trimmed },
    ];

    // Run tool-calling loop
    const newMessages: LlmMessage[] = [{ role: 'user', content: trimmed }];
    const { reply, turnMessages } = await this.runToolLoop(messages, definitions, dispatch, trace);

    // Save this turn to history (user message + all tool interactions + final assistant reply)
    newMessages.push(...turnMessages);
    chatHistory.append(chatId, newMessages);

    return { reply, trace };
  }

  private async runToolLoop(
    messages: LlmMessage[],
    definitions: ToolDefinition[],
    dispatch: Map<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>>,
    trace: string[]
  ): Promise<{ reply: string; turnMessages: LlmMessage[] }> {
    let callCount = 0;
    const maxCalls = config.llmMaxToolCalls;
    const turnMessages: LlmMessage[] = [];

    while (true) {
      const result = await llmService.chat(messages, definitions);

      if (result.toolCalls.length === 0) {
        trace.push('execution_path: final');
        const reply = result.content || 'Keine Antwort vom Modell.';
        turnMessages.push({ role: 'assistant', content: reply });
        return { reply, turnMessages };
      }

      const assistantMsg: LlmMessage = {
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls,
      };
      messages.push(assistantMsg);
      turnMessages.push(assistantMsg);

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

        const toolMsg: LlmMessage = { role: 'tool', content: output, toolName };
        messages.push(toolMsg);
        turnMessages.push(toolMsg);
      }

      if (callCount >= maxCalls) {
        trace.push(`max_tool_calls_reached: ${maxCalls}`);
        logger.warn({ callCount, maxCalls }, 'Max tool calls reached, forcing final response');
        const finalResult = await llmService.chat(messages, []);
        const reply = finalResult.content || 'Tool-Call-Limit erreicht. Bitte versuche es erneut.';
        turnMessages.push({ role: 'assistant', content: reply });
        return { reply, turnMessages };
      }
    }
  }

  private handleModelCommand(input: string, trace: string[]): AssistantResponse {
    const arg = input.replace(/^\/model\s*/i, '').trim().toLowerCase();

    if (!arg) {
      const current = llmService.modelLabel;
      const available = llmService.getAvailableProviders().join(', ');
      trace.push('action: model_info');
      return {
        reply: `Aktuelles Modell: ${current}\nVerfügbar: ${available}\n\nWechsel mit /model ollama oder /model gemini`,
        trace,
      };
    }

    const available = llmService.getAvailableProviders();
    if (!available.includes(arg as LlmProviderName)) {
      trace.push(`action: model_switch_failed (${arg})`);
      return {
        reply: `Unbekannter Provider: "${arg}"\nVerfügbar: ${available.join(', ')}`,
        trace,
      };
    }

    llmService.switchProvider(arg as LlmProviderName);
    trace.push(`action: model_switched to ${arg}`);
    return {
      reply: `Modell gewechselt zu: ${llmService.modelLabel}`,
      trace,
    };
  }

  async handleText(chatId: number, input: string): Promise<string> {
    const result = await this.handleTextWithTrace(chatId, input);
    return result.reply;
  }
}

export const assistant = new Assistant();
