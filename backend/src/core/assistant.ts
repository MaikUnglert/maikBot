import { llmService } from '../services/llm.service.js';
import { mcpHostService } from '../services/mcp-host.service.js';
import { toolRegistry } from './tool-registry.js';
import { chatHistory } from './chat-history.js';
import { config, type LlmProviderName } from '../config.js';
import { logger } from '../logger.js';
import {
  TOOL_CATEGORIES,
  getCategoryIds,
  getToolsForCategories,
  buildCategoryListForPrompt,
} from './tool-categories.js';
import type { LlmMessage, ToolDefinition } from '../services/llm.types.js';

const MAX_TOOL_OUTPUT_CHARS = 8000;

const TRY_AGAIN_HINT =
  'You can try again in a moment, send the same message again, or rephrase your request.';

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...(truncated, result too large)';
}

const SYSTEM_PROMPT = `You are MaikBot, a local AI assistant running on a home server.
Rules:
1) Respond briefly and clearly in English unless the user explicitly asks for another language.
2) You have access to tools (smart home, shell, etc.). Use them when the user's request requires it.
3) Do not invent tool results or device states. Only report what tools return.
4) If a tool call fails with a name/match error, call ha_search_entities or ha_deep_search first to discover the correct entity names, then retry with the correct name. Do NOT give up after the first failed attempt.
5) For shell commands, prefer concise output (e.g. use flags like -h, --no-pager, head/tail).
6) On errors, provide concrete next steps.`;

const TRIAGE_SYSTEM_PROMPT = `You are MaikBot, an AI assistant with smart-home and shell tools.
Your job right now: decide if the user's message needs tools, and if so, which category.

Available tool categories:
${buildCategoryListForPrompt()}

If the user's request requires tools, call the route_to_tools function with the relevant category IDs.
If you can answer directly without any tools (e.g. general knowledge, math, conversation), just reply with text.
IMPORTANT: When in doubt, route to tools. It is better to route unnecessarily than to miss a tool call.
Respond in English unless the user explicitly asks for another language.`;

const ROUTE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'route_to_tools',
    description:
      'Select which tool categories are needed to handle the user request. Call this when the user needs smart-home control, system commands, or any action that requires tools.',
    parameters: {
      type: 'object',
      required: ['categories'],
      properties: {
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: getCategoryIds(),
          },
          description: 'One or more tool category IDs needed for this request',
        },
      },
    },
  },
};

export interface AssistantResponse {
  reply: string;
  trace: string[];
}

export class Assistant {
  /**
   * When the Telegram layer fails after the assistant already returned, or for unexpected throws.
   * Appends the user turn plus a short system-style assistant note so the next LLM call keeps context.
   */
  recoverFromExternalProcessingError(
    chatId: number,
    userText: string,
    error: unknown
  ): AssistantResponse {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, chatId }, 'Unexpected pipeline error');
    this.appendFailedTurnForHistory(chatId, userText, errMsg);
    return {
      reply: `${this.userFacingFailureReply(errMsg)}\n\n${TRY_AGAIN_HINT}`,
      trace: [`error: ${errMsg.slice(0, 300)}`],
    };
  }

  private appendFailedTurnForHistory(chatId: number, userText: string, errMsg: string): void {
    const assistantNote = this.modelContextFailureNote(errMsg);
    chatHistory.append(chatId, [
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantNote },
    ]);
    logger.info({ chatId }, 'Appended failed turn to chat history to preserve context');
  }

  private modelContextFailureNote(errMsg: string): string {
    if (/429|Too Many Requests/i.test(errMsg)) {
      return '[System note: The last user message was not answered because the LLM provider returned HTTP 429 (rate limit).]';
    }
    if (/timed out|Timeout|AbortError/i.test(errMsg)) {
      return '[System note: The last user message was not answered because the LLM request timed out.]';
    }
    if (/NVIDIA HTTP|Gemini|Ollama|Failed to get response from AI/i.test(errMsg)) {
      return '[System note: The last user message was not answered because the LLM provider returned an error.]';
    }
    return '[System note: The last user message was not answered due to a backend or provider error.]';
  }

  private userFacingFailureReply(errMsg: string): string {
    if (/429|Too Many Requests/i.test(errMsg)) {
      return 'The AI provider is temporarily rate-limiting requests.';
    }
    if (/timed out|Timeout/i.test(errMsg)) {
      return 'The AI request took too long and was stopped.';
    }
    if (/HTTP 5\d{2}/i.test(errMsg)) {
      return 'The AI provider returned a server error.';
    }
    if (/HTTP 4\d{2}/i.test(errMsg)) {
      return 'The AI provider rejected or could not complete the request.';
    }
    return 'Something went wrong while processing your message.';
  }

  private recoverFromTurnFailure(
    chatId: number,
    userText: string,
    error: unknown,
    trace: string[]
  ): AssistantResponse {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, chatId }, 'Assistant conversation turn failed');
    trace.push(`error: ${errMsg.slice(0, 300)}`);
    this.appendFailedTurnForHistory(chatId, userText, errMsg);
    return {
      reply: `${this.userFacingFailureReply(errMsg)}\n\n${TRY_AGAIN_HINT}`,
      trace,
    };
  }

  async handleTextWithTrace(chatId: number, input: string): Promise<AssistantResponse> {
    const trimmed = input.trim();
    const trace: string[] = [];

    if (!trimmed) {
      return { reply: 'Please send a message.', trace };
    }

    if (trimmed.startsWith('/model')) {
      return this.handleModelCommand(trimmed, trace);
    }

    if (trimmed === '/clear') {
      chatHistory.clear(chatId);
      trace.push('action: history_cleared');
      return { reply: 'Chat history cleared.', trace };
    }

    if (trimmed === '/status') {
      const stats = chatHistory.getStats(chatId);
      trace.push('action: status');
      return {
        reply: `Model: ${llmService.modelLabel}\nMessages in context: ${stats.messageCount}\nEstimated tokens: ${stats.estimatedTokens}`,
        trace,
      };
    }

    if (trimmed.startsWith('/mcp ')) {
      const instruction = trimmed.replace(/^\/mcp\s+/i, '').trim();
      if (instruction === 'tools' || instruction === 'help') {
        try {
          const result = await mcpHostService.runTool('tools');
          trace.push('action: tools_list');
          return { reply: result.output, trace };
        } catch (error) {
          return this.recoverFromTurnFailure(chatId, trimmed, error, trace);
        }
      }
    }

    trace.push(`provider: ${llmService.modelLabel}`);

    const history = chatHistory.getHistory(chatId);
    trace.push(`history_messages: ${history.length}`);

    try {
      // --- Phase 1: Triage ---
      const triageMessages: LlmMessage[] = [
        { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: trimmed },
      ];

      const triageResult = await llmService.chat(triageMessages, [ROUTE_TOOL_DEFINITION]);

      const routeCall = triageResult.toolCalls.find(
        (tc) => tc.function.name === 'route_to_tools'
      );

      let selectedCategories: string[] = [];

      if (routeCall) {
        const args = routeCall.function.arguments as { categories?: unknown };
        let cats: string[] = [];
        if (Array.isArray(args.categories)) {
          cats = args.categories as string[];
        } else if (typeof args.categories === 'string') {
          cats = [args.categories];
        }
        selectedCategories = cats.filter((id) =>
          TOOL_CATEGORIES.some((c) => c.id === id)
        );
      }

      const isExplicitlyEmpty =
        routeCall &&
        Array.isArray((routeCall.function.arguments as { categories?: unknown }).categories) &&
        ((routeCall.function.arguments as { categories: unknown[] }).categories.length === 0);

      if (selectedCategories.length === 0 && triageResult.toolCalls.length > 0 && !isExplicitlyEmpty) {
        trace.push('phase: triage_fallback_all_categories');
        selectedCategories = getCategoryIds();
      }

      if (selectedCategories.length === 0 && triageResult.content) {
        trace.push('phase: triage_direct_answer');
        const reply = triageResult.content;
        const newMessages: LlmMessage[] = [
          { role: 'user', content: trimmed },
          { role: 'assistant', content: reply },
        ];
        chatHistory.append(chatId, newMessages);
        return { reply, trace };
      }

      if (selectedCategories.length === 0) {
        trace.push('phase: triage_empty_fallback_to_phase2');
      } else {
        trace.push(`phase: routed → [${selectedCategories.join(', ')}]`);
      }

      // --- Phase 2: Execute with filtered tools ---
      const allowedToolNames = getToolsForCategories(selectedCategories);
      for (const name of ['ha_search_entities', 'ha_deep_search']) {
        allowedToolNames.add(name);
      }

      const { definitions, dispatch } = await toolRegistry.loadTools(allowedToolNames);
      trace.push(`tools_loaded: ${definitions.length}`);

      const execMessages: LlmMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: trimmed },
      ];

      const newMessages: LlmMessage[] = [{ role: 'user', content: trimmed }];
      const { reply, turnMessages } = await this.runToolLoop(
        execMessages,
        definitions,
        dispatch,
        trace
      );

      newMessages.push(...turnMessages);
      chatHistory.append(chatId, newMessages);

      return { reply, trace };
    } catch (error) {
      return this.recoverFromTurnFailure(chatId, trimmed, error, trace);
    }
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
        let reply = (result.content ?? '').trim();
        if (!reply) {
          trace.push('execution_path: empty_reply_retry');
          const retryMessages: LlmMessage[] = [
            ...messages,
            {
              role: 'user',
              content:
                'Your last turn had no assistant text. In English, reply in one or two short sentences: what you did or what failed, based only on the conversation and tool results above.',
            },
          ];
          const retry = await llmService.chat(retryMessages, []);
          reply = (retry.content ?? '').trim();
        }
        if (!reply) {
          reply =
            'No response from the model. Try again or rephrase; if it keeps happening, check backend logs and LLM connectivity.';
        }
        turnMessages.push({ role: 'assistant', content: reply });
        return { reply, turnMessages };
      }

      const toolCallsWithIds = result.toolCalls.map((tc, i) => ({
        ...tc,
        id: tc.id ?? `call_${i}`,
      }));

      const assistantMsg: LlmMessage = {
        role: 'assistant',
        content: result.content,
        toolCalls: toolCallsWithIds,
      };
      messages.push(assistantMsg);
      turnMessages.push(assistantMsg);

      for (const tc of toolCallsWithIds) {
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

        const toolMsg: LlmMessage = {
          role: 'tool',
          content: truncateToolOutput(output),
          toolName,
          toolCallId: tc.id,
        };
        messages.push(toolMsg);
        turnMessages.push(toolMsg);
      }

      if (callCount >= maxCalls) {
        trace.push(`max_tool_calls_reached: ${maxCalls}`);
        logger.warn({ callCount, maxCalls }, 'Max tool calls reached, forcing final response');
        const finalResult = await llmService.chat(messages, []);
        const reply =
          finalResult.content?.trim() ||
          'Tool call limit reached. Please try again with a simpler request.';
        turnMessages.push({ role: 'assistant', content: reply });
        return { reply, turnMessages };
      }
    }
  }

  private handleModelCommand(input: string, trace: string[]): AssistantResponse {
    const rawArgs = input.replace(/^\/model\s*/i, '').trim();
    const args = rawArgs.split(/\s+/);
    const providerArg = args[0]?.toLowerCase();
    const modelArg = args[1]; // optional specific model name

    if (!providerArg) {
      const current = llmService.modelLabel;
      const available = llmService.getAvailableProviders().join(', ');
      trace.push('action: model_info');
      return {
        reply: `Current model: ${current}\nAvailable: ${available}\n\nExamples:\n/model ollama\n/model ollama llama3.2:3b\n/model gemini gemini-2.5-flash\n/model nvidia\n/model nvidia moonshotai/kimi-k2.5`,
        trace,
      };
    }

    const available = llmService.getAvailableProviders();
    if (!available.includes(providerArg as LlmProviderName)) {
      trace.push(`action: model_switch_failed (${providerArg})`);
      return {
        reply: `Unknown provider: "${providerArg}"\nAvailable: ${available.join(', ')}`,
        trace,
      };
    }

    if (modelArg) {
      if (providerArg === 'ollama') {
        config.ollamaModel = modelArg;
      } else if (providerArg === 'gemini') {
        config.geminiModel = modelArg;
      } else if (providerArg === 'nvidia') {
        config.nvidiaModel = modelArg;
      }
      trace.push(`action: specific_model_set (${modelArg})`);
    }

    llmService.switchProvider(providerArg as LlmProviderName);
    trace.push(`action: model_switched to ${providerArg}`);
    return {
      reply: `Switched model to: ${llmService.modelLabel}`,
      trace,
    };
  }

  async handleText(chatId: number, input: string): Promise<string> {
    const result = await this.handleTextWithTrace(chatId, input);
    return result.reply;
  }
}

export const assistant = new Assistant();
