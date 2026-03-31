import path from 'node:path';
import { llmService } from '../services/llm.service.js';
import { mcpHostService } from '../services/mcp-host.service.js';
import { performUpdate } from '../services/update.service.js';
import { sendToSession } from '../services/channel-sender.service.js';
import { toolRegistry, type RegisteredTool } from './tool-registry.js';
import { chatHistory } from './chat-history.js';
import { config, type LlmProviderName } from '../config.js';
import { logger } from '../logger.js';
import {
  ON_DEMAND_HA_CATEGORY_IDS,
  getToolsForCategories,
  getAlwaysLoadedToolNames,
  buildOnDemandHaCategoryListForPrompt,
} from './tool-categories.js';
import type { LlmMessage, ToolDefinition } from '../services/llm.types.js';
import { readMemory } from './tools/memory.js';
import type { SessionId } from './channel-types.js';

const MAX_TOOL_OUTPUT_CHARS = 8000;

const TRY_AGAIN_HINT =
  'You can try again in a moment, send the same message again, or rephrase your request.';

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...(truncated, result too large)';
}

/**
 * Detect typical Home Assistant on/off / toggle phrasing (DE/EN) to use a smaller HA tool set without on-demand categories.
 * Conservative: long lines and slash-commands never match.
 */
function tryHaFastPathCategories(text: string): string[] | null {
  if (!config.llmHaFastPath) return null;
  const t = text.trim();
  if (t.length > 200 || t.startsWith('/')) return null;

  const german =
    /\b(mach|mache|schalt|schalte|stell|stelle|dimme?)\s+[^\n!?]{1,55}\s+(an|aus|ein)\b/i.test(t);
  const english =
    /\b(turn|switch|set|dim)\s+[^\n!?]{1,55}\s+(on|off)\b/i.test(t);
  const toggleEn = /\btoggle\s+[^\n!?]{2,55}\b/i.test(t);

  if (german || english || toggleEn) {
    return ['search', 'control'];
  }
  return null;
}

/**
 * Detect URL or website requests. When present, browser category must be included
 * so the agent gets browser_navigate etc. Returns ['browser'] or null.
 */
function tryUrlFastPathCategories(text: string): string[] | null {
  const t = text.trim();
  if (t.length > 500 || t.startsWith('/')) return null;
  const hasUrl = /https?:\/\/[^\s]+/i.test(t);
  const hasWebsiteMention =
    /\b(zeit\.de|spiegel\.de|website|webseite|seite\s+öffnen|öffne\s+die|auf\s+(diesen\s+)?link|diesen\s+link|zugreif(en|en\s+auf)|website|webpage)\b/i.test(t);
  if (hasUrl || hasWebsiteMention) {
    return ['browser'];
  }
  return null;
}

/** Returns true if the message looks like a save confirmation (ja, yes, ok, etc.). */
function looksLikeSaveConfirmation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 50) return false;
  return (
    /^(ja|yes|yep|yeah|ok|sure|bitte|gerne|ja\s+bitte|ja\s+gerne|speichern?|save\s*it?)$/i.test(t) ||
    /^(ja|yes)\s*[,!.]?\s*$/i.test(t)
  );
}

/** Returns true if the most recent assistant message asks whether to save to memory. */
function lastAssistantAskedToSave(messages: LlmMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    return (
      /should I save this to memory/i.test(content) ||
      /soll ich (das|es) (in die )?memory/i.test(content) ||
      /sollen wir (das|es) speichern/i.test(content) ||
      /save (this|it) to memory\?/i.test(content)
    );
  }
  return false;
}

function buildSystemPrompt(memoryContent: string): string {
  const now = new Date();
  const memoryPath = `${config.memoryDataDir}/memory.md`;
  const timeStr = now.toLocaleString('en-GB', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const projectRoot = path.resolve(process.cwd(), '..');

  // === Dynamic sections ===
  const memorySection =
    memoryContent.trim().length > 0
      ? `\n\n[Memory]\n${memoryContent}\n[/Memory]`
      : '';

  const browserNote = config.browserEnabled
    ? '\n• Browser: browser_navigate, browser_snapshot for web pages'
    : '';
  const visionNote =
    config.geminiApiKey || config.ollamaBaseUrl
      ? '\n• Vision: vision_analyze_image for photos/screenshots'
      : '';

  const reposWorkspace = path.relative(config.geminiCliWorkspaceRoot, config.gitReposDir);
  const reposNote =
    !reposWorkspace.startsWith('..') && reposWorkspace !== ''
      ? `\n\n[External Repos]\nClone to ${config.gitReposDir}, then gemini_cli_delegate with workspace="${reposWorkspace}/<repo>"\n[/External Repos]`
      : '';

  return `You are MaikBot, a self-modifying AI assistant on a home server.
Date: ${timeStr} | Codebase: ${projectRoot}
${memorySection}${reposNote}

=== CAPABILITIES ===
• Shell: shell_exec (async=true for long tasks), file ops via cat/echo/sed
• Home Assistant: ha_search_entities, ha_get_state, device control. For automations/config/history/calendar/system/hacs: call load_ha_tool_categories first${browserNote}${visionNote}
• Scheduling: schedule_reminder (one-time), schedule_daily, schedule_weekly
• Self-modification: gemini_cli_delegate for code changes, shell_exec for quick edits
• Scanning: scan_add_page → "fertig" for PDF

=== BEHAVIOR ===
1. Respond briefly in user's language. Format: **bold**, bullets (•), no Markdown tables.
2. Use tools—don't invent results. On HA name errors: ha_search_entities first, then retry.
3. Memory (${memoryPath}): Proactively save nicknames, preferences, facts. Ask "Save to memory?" then: echo "- key: value" >> ${memoryPath}
4. Scheduling: Be proactive—suggest recurring tasks for patterns ("Shall I send weather daily?").
5. Long tasks: shell_exec async=true, or gemini_cli_delegate for multi-file code work.

=== SELF-MODIFICATION ===
You CAN change your own code, prompts, commands, and behavior. Key files:
• assistant.ts (this prompt), tools/*.ts, services/*.ts, config.ts

For changes:
• Small edits: shell_exec + ask user to /reload
• Larger changes: gemini_cli_delegate → feature branch → commit → push → gh pr create
• Never commit to main. After PR merge: user runs /update

Self-update: maikbot_self_update mode="full" (or "local" for rebuild-only)

=== GIT AUTH ===
If git push fails: user must configure credentials (credential.helper, SSH keys, or token in remote URL). MaikBot doesn't provide GITHUB_TOKEN to git.

=== HA TOOL CATEGORIES ===
Call load_ha_tool_categories with IDs when needed:
${buildOnDemandHaCategoryListForPrompt()}`;
}

const LOAD_HA_TOOL_CATEGORIES_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'load_ha_tool_categories',
    description:
      'Load extra Home Assistant MCP tools for this conversation turn. Base tools already include entity search, state, and device control. Call this when the user needs automations/scripts, full config (areas, helpers, integrations), dashboards, history/logbook/camera, calendar/todos, HA system ops (restart, backups, updates), or HACS. You can pass multiple category IDs at once. Safe to call again with new IDs; already-loaded categories are no-ops.',
    parameters: {
      type: 'object',
      required: ['categories'],
      properties: {
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...ON_DEMAND_HA_CATEGORY_IDS],
          },
          description:
            'Category IDs to load: automation, config, dashboard, history, calendar, system, hacs',
        },
      },
    },
  },
};

export interface AssistantResponse {
  reply: string;
  trace: string[];
}

/** Optional UI hook (e.g. Telegram status line). Must not throw. */
export type AssistantProgressCallback = (phase: string) => void | Promise<void>;

export interface AssistantHandleOptions {
  onProgress?: AssistantProgressCallback;
  /** Attached image (e.g. from Telegram photo). Sent directly to vision-capable models. */
  attachedImage?: { base64: string; mimeType: string };
}

export class Assistant {
  /**
   * When the Telegram layer fails after the assistant already returned, or for unexpected throws.
   * Appends the user turn plus a short system-style assistant note so the next LLM call keeps context.
   */
  recoverFromExternalProcessingError(
    sessionId: SessionId,
    userText: string,
    error: unknown
  ): AssistantResponse {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sessionId }, 'Unexpected pipeline error');
    this.appendFailedTurnForHistory(sessionId, userText, errMsg);
    return {
      reply: `${this.userFacingFailureReply(errMsg)}\n\n${TRY_AGAIN_HINT}`,
      trace: [`error: ${errMsg.slice(0, 300)}`],
    };
  }

  private appendFailedTurnForHistory(sessionId: SessionId, userText: string, errMsg: string): void {
    const assistantNote = this.modelContextFailureNote(errMsg);
    chatHistory.append(sessionId, [
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantNote },
    ]);
    logger.info({ sessionId }, 'Appended failed turn to chat history to preserve context');
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
    sessionId: SessionId,
    userText: string,
    error: unknown,
    trace: string[]
  ): AssistantResponse {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sessionId }, 'Assistant conversation turn failed');
    trace.push(`error: ${errMsg.slice(0, 300)}`);
    this.appendFailedTurnForHistory(sessionId, userText, errMsg);
    return {
      reply: `${this.userFacingFailureReply(errMsg)}\n\n${TRY_AGAIN_HINT}`,
      trace,
    };
  }

  async handleTextWithTrace(
    sessionId: SessionId,
    input: string,
    options?: AssistantHandleOptions
  ): Promise<AssistantResponse> {
    const trimmed = input.trim();
    const trace: string[] = [];
    const report = async (phase: string): Promise<void> => {
      try {
        await options?.onProgress?.(phase);
      } catch {
        /* progress UI must not break the assistant */
      }
    };

    if (!trimmed) {
      return { reply: 'Please send a message.', trace };
    }

    if (trimmed.startsWith('/model')) {
      return this.handleModelCommand(trimmed, trace);
    }

    if (trimmed === '/update') {
      trace.push('action: update');
      const result = await performUpdate('full', {
        onSuccess: async (msg) => { await sendToSession(sessionId, msg); },
      });
      return {
        reply: result.ok ? 'Update complete. Restarting…' : `Update failed:\n${result.output}`,
        trace,
      };
    }

    if (trimmed === '/reload') {
      trace.push('action: reload');
      const result = await performUpdate('local', {
        onSuccess: async (msg) => { await sendToSession(sessionId, msg); },
      });
      return {
        reply: result.ok ? 'Reload complete. Restarting…' : `Reload failed:\n${result.output}`,
        trace,
      };
    }

    if (trimmed === '/clear') {
      chatHistory.clear(sessionId);
      trace.push('action: history_cleared');
      return { reply: 'Chat history cleared.', trace };
    }

    if (trimmed === '/status') {
      const stats = chatHistory.getStats(sessionId);
      trace.push('action: status');
      return {
        reply: `Model: ${llmService.modelLabel}\nMessages in context: ${stats.messageCount}\nEstimated tokens: ${stats.estimatedTokens}`,
        trace,
      };
    }

    if (trimmed === '/info' || trimmed === '/help' || trimmed === '/commands') {
      trace.push('action: info');
      return {
        reply: `**Commands**

/clear – Clear chat history
/model – Switch LLM (ollama / gemini / nvidia). Example: /model nvidia
/update – Pull updates, build, restart (needs process manager)
/reload – Build and restart only (for Gemini CLI self-improvements)
/status – Show session status (model, message count, tokens)
/scan – Scan document (HP WebScan or SANE). /scan done, /scan cancel. Upload PDF → send to Paperless.
/mcp tools – List MCP tools (e.g. Home Assistant)
/night – Turn off all lights and enable night mode in Home Assistant
/info – This help`,
        trace,
      };
    }

    if (trimmed === '/night') {
      trace.push('action: night_mode');
      const feedback: string[] = ['Turning off all lights and enabling night mode.'];
      try {
        await mcpHostService.callTool('ha_call_service', {
          domain: 'light',
          service: 'turn_off',
          service_data: {},
        });
        feedback.push('Lights turned off.');
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        feedback.push(`Failed to turn off lights: ${errMsg}`);
        logger.error({ err: error }, 'Failed to turn off lights');
      }

      try {
        await mcpHostService.callTool('ha_call_service', {
          domain: 'input_boolean',
          service: 'turn_on',
          service_data: { entity_id: 'input_boolean.nachtmodus' },
        });
        feedback.push('Night mode enabled.');
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        feedback.push(`Failed to enable night mode: ${errMsg}. If "input_boolean.nachtmodus" does not exist, consider creating it in Home Assistant.`);
        logger.error({ err: error }, 'Failed to enable night mode');
      }

      return {
        reply: feedback.join('\n'),
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
          return this.recoverFromTurnFailure(sessionId, trimmed, error, trace);
        }
      }
    }

    trace.push(`provider: ${llmService.modelLabel}`);

    const history = chatHistory.getHistory(sessionId);
    trace.push(`history_messages: ${history.length}`);

    const currentUserMessage: LlmMessage = {
      role: 'user',
      content: trimmed,
      ...(options?.attachedImage && { imageAttachment: options.attachedImage }),
    };

    try {
      await report('Preparing…');
      let selectedCategories: string[] = [];
      let includeLoadHaTool = false;

      const fastCats = tryHaFastPathCategories(trimmed);
      const urlCats = tryUrlFastPathCategories(trimmed);
      if (fastCats) {
        trace.push(`phase: ha_fast_path → [${fastCats.join(', ')}]`);
        await report('Quick path: device search & control…');
        selectedCategories = fastCats;
        includeLoadHaTool = true;
      } else if (urlCats) {
        trace.push(`phase: url_fast_path → [${urlCats.join(', ')}]`);
        await report('Loading browser tools…');
        selectedCategories = urlCats;
        includeLoadHaTool = true;
      } else {
        trace.push('phase: base_tools_plus_load_ha');
        includeLoadHaTool = true;
      }

      const pendingSaveConfirmation =
        selectedCategories.length === 0 &&
        looksLikeSaveConfirmation(trimmed) &&
        lastAssistantAskedToSave(history);

      if (pendingSaveConfirmation) {
        trace.push('phase: save_confirmation_force_shell');
        selectedCategories = ['shell'];
      }

      const loadedHaCategories = new Set(
        selectedCategories.filter((id) =>
          (ON_DEMAND_HA_CATEGORY_IDS as readonly string[]).includes(id)
        )
      );

      const buildAllowedToolNames = (): Set<string> => {
        const names = new Set(getAlwaysLoadedToolNames());
        for (const n of getToolsForCategories(selectedCategories)) {
          names.add(n);
        }
        for (const id of loadedHaCategories) {
          for (const n of getToolsForCategories([id])) {
            names.add(n);
          }
        }
        if (includeLoadHaTool) {
          names.add('load_ha_tool_categories');
        }
        return names;
      };

      const executeLoadHaTool = async (
        args: Record<string, unknown>
      ): Promise<{ ok: boolean; output: string }> => {
        const raw = args.categories;
        let requested: string[] = [];
        if (Array.isArray(raw)) {
          requested = raw.filter((x) => typeof x === 'string') as string[];
        } else if (typeof raw === 'string') {
          requested = [raw];
        }
        const valid = new Set<string>(ON_DEMAND_HA_CATEGORY_IDS as unknown as string[]);
        const added: string[] = [];
        const unknown: string[] = [];
        for (const id of requested) {
          if (valid.has(id)) {
            if (!loadedHaCategories.has(id)) {
              loadedHaCategories.add(id);
              added.push(id);
            }
          } else if (id.trim()) {
            unknown.push(id);
          }
        }
        const parts: string[] = [];
        if (added.length > 0) {
          parts.push(`Loaded HA tool categories: ${added.join(', ')}. Matching ha_* tools are now available.`);
        } else if (requested.length === 0) {
          parts.push('No categories provided. Pass categories: automation, config, dashboard, history, calendar, system, and/or hacs.');
        } else {
          parts.push('All requested categories were already loaded (or only invalid IDs were given).');
        }
        if (unknown.length > 0) {
          parts.push(`Ignored unknown IDs: ${unknown.join(', ')}.`);
        }
        trace.push(`load_ha_tool_categories: added=[${added.join(',')}] loaded=[${[...loadedHaCategories].join(',')}]`);
        return { ok: true, output: parts.join(' ') };
      };

      const loadHaRegisteredTool: RegisteredTool = {
        definition: LOAD_HA_TOOL_CATEGORIES_DEFINITION,
        execute: executeLoadHaTool,
      };

      await report('Loading tools…');
      let allowedToolNames = buildAllowedToolNames();
      let toolBundle = await toolRegistry.loadTools(
        allowedToolNames,
        { sessionId },
        includeLoadHaTool ? [loadHaRegisteredTool] : []
      );
      trace.push(
        `tools_loaded: ${toolBundle.definitions.length} (categories: ${selectedCategories.join(', ') || 'base'}; on_demand_ha: ${[...loadedHaCategories].join(', ') || 'none'})`
      );

      const memoryContent = await readMemory();
      const execMessages: LlmMessage[] = [
        { role: 'system', content: buildSystemPrompt(memoryContent) },
        ...history,
        currentUserMessage,
      ];

      const newMessages: LlmMessage[] = [currentUserMessage];
      const toolState = { bundle: toolBundle };
      const { reply, turnMessages } = await this.runToolLoop(
        execMessages,
        toolState,
        trace,
        options?.onProgress,
        includeLoadHaTool
          ? {
              reloadTools: async () => {
                allowedToolNames = buildAllowedToolNames();
                toolState.bundle = await toolRegistry.loadTools(
                  allowedToolNames,
                  { sessionId },
                  [loadHaRegisteredTool]
                );
                trace.push(
                  `tools_reloaded: ${toolState.bundle.definitions.length} (on_demand_ha: ${[...loadedHaCategories].join(', ')})`
                );
              },
            }
          : undefined
      );

      newMessages.push(...turnMessages);
      const messagesForHistory = newMessages.map((m) => {
        const { imageAttachment: _, ...rest } = m;
        return rest as LlmMessage;
      });
      chatHistory.append(sessionId, messagesForHistory);

      return { reply, trace };
    } catch (error) {
      return this.recoverFromTurnFailure(sessionId, trimmed, error, trace);
    }
  }

  /** User-friendly progress text for Telegram overlay (avoid technical tool names). */
  private getProgressPhaseForTool(
    toolName: string,
    _toolArgs: Record<string, unknown>
  ): string {
    const phases: Record<string, string> = {
      shell_exec: 'Running your command…',
      shell_job_result: 'Checking command result…',
      maikbot_self_update: 'Updating maikBot…',
      gemini_cli_delegate: 'Starting Gemini CLI…',
      gemini_cli_status: 'Checking Gemini CLI status…',
      schedule_reminder: 'Setting reminder…',
      schedule_daily: 'Setting daily task…',
      schedule_weekly: 'Setting weekly task…',
      schedule_list: 'Listing scheduled tasks…',
      schedule_cancel: 'Cancelling task…',
      agent_config_get: 'Reading config…',
      agent_config_set: 'Updating config…',
      scan_add_page: 'Scanning at printer…',
      scan_status: 'Checking scan status…',
      scan_cancel: 'Cancelling scan…',
    };
    if (phases[toolName]) return phases[toolName];
    if (toolName === 'load_ha_tool_categories') return 'Loading Home Assistant tools…';
    if (toolName.startsWith('ha_')) return 'Calling Home Assistant…';
    return 'Working…';
  }

  private async runToolLoop(
    messages: LlmMessage[],
    toolState: {
      bundle: {
        definitions: ToolDefinition[];
        dispatch: Map<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>>;
      };
    },
    trace: string[],
    onProgress?: AssistantProgressCallback,
    dynamicTools?: { reloadTools: () => Promise<void> }
  ): Promise<{ reply: string; turnMessages: LlmMessage[] }> {
    let definitions = toolState.bundle.definitions;
    let dispatch = toolState.bundle.dispatch;
    const report = async (phase: string): Promise<void> => {
      try {
        await onProgress?.(phase);
      } catch {
        /* ignore */
      }
    };

    let callCount = 0;
    const maxCalls = config.llmMaxToolCalls; // 0 = unlimited
    const turnMessages: LlmMessage[] = [];

    while (true) {
      await report('Calling the language model…');
      const result = await llmService.chat(messages, definitions);

      if (result.toolCalls.length === 0) {
        trace.push('execution_path: final');
        let reply = (result.content ?? '').trim();
        if (!reply) {
          trace.push('execution_path: empty_reply_retry');
          await report('Finishing answer…');
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
        const progressPhase = this.getProgressPhaseForTool(toolName, toolArgs);
        await report(progressPhase);

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
            if (toolName === 'load_ha_tool_categories' && dynamicTools) {
              await dynamicTools.reloadTools();
              definitions = toolState.bundle.definitions;
              dispatch = toolState.bundle.dispatch;
            }
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

      if (maxCalls > 0 && callCount >= maxCalls) {
        trace.push(`max_tool_calls_reached: ${maxCalls}`);
        logger.warn({ callCount, maxCalls }, 'Max tool calls reached, forcing final response');
        await report('Summarizing (tool limit reached)…');
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

  async handleText(sessionId: SessionId, input: string): Promise<string> {
    const result = await this.handleTextWithTrace(sessionId, input);
    return result.reply;
  }
}

export const assistant = new Assistant();
