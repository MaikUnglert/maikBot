import { mcpHostService } from '../services/mcp-host.service.js';
import { ollamaService } from '../services/ollama.service.js';
import { logger } from '../logger.js';

const CHAT_SYSTEM_PROMPT = `You are MaikBot, a local AI assistant.
Rules:
1) Respond briefly and clearly in German unless the user asks for another language.
2) Do not invent tool results or device states.
3) If external tools are needed, they are handled by the backend MCP skill layer.
4) On errors, provide concrete next steps.`;

type SkillIntent =
  | { type: 'turn_on'; target: string }
  | { type: 'turn_off'; target: string }
  | { type: 'set_brightness'; target: string; brightness: number }
  | { type: 'set_temperature'; target: string; temperature: number }
  | { type: 'query_live_context' }
  | { type: 'todo_get' }
  | { type: 'todo_add'; item: string; listName?: string }
  | { type: 'todo_complete'; item: string; listName?: string }
  | { type: 'unknown' };

interface PlannerDecision {
  action?: 'tool_call' | 'final';
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  response?: string;
}

export interface AssistantResponse {
  reply: string;
  trace: string[];
}

export class Assistant {
  private parseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fallback below
    }

    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }

    return null;
  }

  private normalizeTarget(raw: string): string {
    return raw
      .trim()
      .replace(/^(den|die|das|dem|der)\s+/i, '')
      .replace(/[.!?]+$/g, '')
      .trim();
  }

  private detectIntent(userInput: string): SkillIntent {
    const text = userInput.trim();
    const lower = text.toLowerCase();

    const offMatch =
      lower.match(/^(?:mach|schalt(?:e)?)\s+(.+?)\s+aus[.!?]?$/i) ??
      lower.match(/^turn\s+off\s+(.+?)[.!?]?$/i);
    if (offMatch?.[1]) {
      return { type: 'turn_off', target: this.normalizeTarget(offMatch[1]) };
    }

    const onMatch =
      lower.match(/^(?:mach|schalt(?:e)?)\s+(.+?)\s+an[.!?]?$/i) ??
      lower.match(/^turn\s+on\s+(.+?)[.!?]?$/i);
    if (onMatch?.[1]) {
      return { type: 'turn_on', target: this.normalizeTarget(onMatch[1]) };
    }

    const brightnessMatch =
      lower.match(/(?:helligkeit|brightness|dim|dimm).*?(\d{1,3})\s*(?:%|prozent|percent)/i) ??
      lower.match(/(\d{1,3})\s*(?:%|prozent|percent).*(?:helligkeit|brightness|dimm|dim)/i);
    if (brightnessMatch?.[1]) {
      const brightness = Number.parseInt(brightnessMatch[1], 10);
      if (Number.isInteger(brightness) && brightness >= 0 && brightness <= 100) {
        const withoutPercent = text.replace(brightnessMatch[0], '').trim();
        const target = this.normalizeTarget(withoutPercent || 'light');
        return { type: 'set_brightness', target, brightness };
      }
    }

    const tempMatch = lower.match(/(?:temperatur|temperature).*?(\d{1,2})(?:\s*(?:grad|degrees|°c))?/i);
    if (tempMatch?.[1]) {
      const temperature = Number.parseInt(tempMatch[1], 10);
      if (Number.isInteger(temperature)) {
        const withoutTemp = text.replace(tempMatch[0], '').trim();
        const target = this.normalizeTarget(withoutTemp || 'climate');
        return { type: 'set_temperature', target, temperature };
      }
    }

    if (
      /\b(status|zustand|ist .* an|ist .* aus|wie ist|state|currently|gerade)\b/i.test(lower)
    ) {
      return { type: 'query_live_context' };
    }

    if (/\b(todo|aufgabe|liste|einkaufsliste|tasks?)\b/i.test(lower)) {
      if (/\b(hinzufügen|add|eintragen)\b/i.test(lower)) {
        const item = text.replace(/.*?(hinzufügen|add|eintragen)\s*/i, '').trim();
        if (item) {
          return { type: 'todo_add', item };
        }
      }
      if (/\b(erledigt|complete|abhaken|done)\b/i.test(lower)) {
        const item = text.replace(/.*?(erledigt|complete|abhaken|done)\s*/i, '').trim();
        if (item) {
          return { type: 'todo_complete', item };
        }
      }
      return { type: 'todo_get' };
    }

    return { type: 'unknown' };
  }

  private async callIntent(
    intent: SkillIntent,
    availableTools: Set<string>,
    explicitUserCommand: boolean,
    trace: string[]
  ): Promise<{ handled: boolean; output: string }> {
    if (intent.type === 'turn_off') {
      if (!intent.target) {
        return { handled: true, output: 'Welches Gerät soll ich ausschalten?' };
      }
      if (!availableTools.has('HassTurnOff')) {
        return { handled: true, output: 'Das Tool HassTurnOff ist aktuell nicht verfügbar.' };
      }
      const result = await mcpHostService.callTool(
        'HassTurnOff',
        { name: intent.target },
        { explicitUserCommand }
      );
      trace.push(`tool_call: HassTurnOff args=${JSON.stringify({ name: intent.target })}`);
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'turn_on') {
      if (!intent.target) {
        return { handled: true, output: 'Welches Gerät soll ich einschalten?' };
      }
      if (!availableTools.has('HassTurnOn')) {
        return { handled: true, output: 'Das Tool HassTurnOn ist aktuell nicht verfügbar.' };
      }
      const result = await mcpHostService.callTool(
        'HassTurnOn',
        { name: intent.target },
        { explicitUserCommand }
      );
      trace.push(`tool_call: HassTurnOn args=${JSON.stringify({ name: intent.target })}`);
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'set_brightness') {
      if (!availableTools.has('HassLightSet')) {
        return { handled: true, output: 'Das Tool HassLightSet ist aktuell nicht verfügbar.' };
      }
      const result = await mcpHostService.callTool(
        'HassLightSet',
        {
          name: intent.target,
          brightness: intent.brightness,
        },
        { explicitUserCommand }
      );
      trace.push(
        `tool_call: HassLightSet args=${JSON.stringify({
          name: intent.target,
          brightness: intent.brightness,
        })}`
      );
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'set_temperature') {
      if (!availableTools.has('HassClimateSetTemperature')) {
        return {
          handled: true,
          output: 'Das Tool HassClimateSetTemperature ist aktuell nicht verfügbar.',
        };
      }
      const result = await mcpHostService.callTool(
        'HassClimateSetTemperature',
        {
          name: intent.target,
          temperature: intent.temperature,
        },
        { explicitUserCommand }
      );
      trace.push(
        `tool_call: HassClimateSetTemperature args=${JSON.stringify({
          name: intent.target,
          temperature: intent.temperature,
        })}`
      );
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'query_live_context' && availableTools.has('GetLiveContext')) {
      const result = await mcpHostService.callTool(
        'GetLiveContext',
        {},
        { explicitUserCommand }
      );
      trace.push('tool_call: GetLiveContext args={}');
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'todo_get' && availableTools.has('todo_get_items')) {
      const result = await mcpHostService.callTool(
        'todo_get_items',
        {},
        { explicitUserCommand }
      );
      trace.push('tool_call: todo_get_items args={}');
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'todo_add' && availableTools.has('HassListAddItem')) {
      const result = await mcpHostService.callTool(
        'HassListAddItem',
        {
          item: intent.item,
          ...(intent.listName ? { name: intent.listName } : {}),
        },
        { explicitUserCommand }
      );
      trace.push(
        `tool_call: HassListAddItem args=${JSON.stringify({
          item: intent.item,
          ...(intent.listName ? { name: intent.listName } : {}),
        })}`
      );
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    if (intent.type === 'todo_complete' && availableTools.has('HassListCompleteItem')) {
      const result = await mcpHostService.callTool(
        'HassListCompleteItem',
        {
          item: intent.item,
          ...(intent.listName ? { name: intent.listName } : {}),
        },
        { explicitUserCommand }
      );
      trace.push(
        `tool_call: HassListCompleteItem args=${JSON.stringify({
          item: intent.item,
          ...(intent.listName ? { name: intent.listName } : {}),
        })}`
      );
      trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
      return { handled: true, output: result.output };
    }

    return { handled: false, output: '' };
  }

  private async runMcpPlannerFallback(
    userInstruction: string,
    tools: Array<{ server: string; name: string; description?: string }>,
    explicitUserCommand: boolean,
    trace: string[]
  ): Promise<string> {
    const fallbackSystemPrompt = `You are an MCP tool planner.
Return exactly one JSON object without markdown.
Allowed outputs:
{"action":"tool_call","server":"<optional server name>","tool":"<toolName>","arguments":{...}}
{"action":"final","response":"<short response to user>"}
Rules:
- Use only provided servers/tools.
- Prefer deterministic direct tools for obvious intents when possible.
- Only use todo/list tools when the user asks for todo/list tasks.`;

    const fallbackUserPrompt = `User request:
${userInstruction}

Available tools:
${JSON.stringify(
  tools.map((tool) => ({
    server: tool.server,
    name: tool.name,
    description: tool.description ?? '',
  }))
)}

Return JSON now.`;

    const modelResponse = await ollamaService.generate(fallbackSystemPrompt, fallbackUserPrompt);
    const parsed = this.parseJsonObject(modelResponse) as PlannerDecision | null;
    if (!parsed) {
      trace.push('planner: non-json response');
      return `Konnte die Planungsantwort nicht lesen: ${modelResponse}`;
    }

    if (parsed.action === 'final' && typeof parsed.response === 'string') {
      trace.push('planner: final response without tool_call');
      return parsed.response;
    }

    if (parsed.action !== 'tool_call' || typeof parsed.tool !== 'string') {
      return `Ungültige Planungsantwort: ${JSON.stringify(parsed)}`;
    }

    const args =
      parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? parsed.arguments
        : {};
    trace.push(
      `planner_tool_call: ${parsed.server ? `[${parsed.server}] ` : ''}${parsed.tool} args=${JSON.stringify(args)}`
    );
    const result = await mcpHostService.callTool(parsed.tool, args, {
      ...(typeof parsed.server === 'string' && parsed.server.trim()
        ? { server: parsed.server.trim() }
        : {}),
      explicitUserCommand,
    });
    trace.push(`tool_result: ${result.ok ? 'ok' : 'error'} ${result.output.slice(0, 180)}`);
    return result.output;
  }

  private async runMcpSkill(
    userInstruction: string,
    explicitUserCommand: boolean,
    trace: string[]
  ): Promise<string> {
    const tools = await mcpHostService.listTools();
    if (tools.length === 0) {
      return 'Keine MCP-Tools verfügbar.';
    }
    trace.push(`tools_available: ${tools.length}`);

    const toolSet = new Set(tools.map((tool) => tool.name));
    const intent = this.detectIntent(userInstruction);
    logger.info({ intent }, 'Detected MCP skill intent');
    trace.push(`intent: ${JSON.stringify(intent)}`);

    const direct = await this.callIntent(intent, toolSet, explicitUserCommand, trace);
    if (direct.handled) {
      trace.push('execution_path: deterministic');
      return direct.output;
    }

    trace.push('execution_path: planner_fallback');
    return this.runMcpPlannerFallback(userInstruction, tools, explicitUserCommand, trace);
  }

  private async decideRoute(userInput: string): Promise<'chat' | 'mcp'> {
    if (!mcpHostService.isConfigured()) {
      return 'chat';
    }

    if (
      /(?:\b(licht|lampe|schreibtisch|steckdose|heizung|thermostat|wohnzimmer|küche)\b)|(?:\b(turn|switch|on|off|status|zustand|temperatur|brightness)\b)/i.test(
        userInput
      )
    ) {
      return 'mcp';
    }

    const routerPrompt = `You are a strict request router.
Return exactly one JSON object:
{"route":"mcp"} or {"route":"chat"}
Use mcp for requests that should use available MCP tools.
Use chat otherwise.`;

    try {
      const response = await ollamaService.generate(routerPrompt, userInput);
      const parsed = this.parseJsonObject(response);
      const route = typeof parsed?.route === 'string' ? parsed.route : '';
      return route === 'mcp' ? 'mcp' : 'chat';
    } catch (error) {
      logger.warn({ err: error }, 'Route decision failed, fallback to chat');
      return 'chat';
    }
  }

  async handleTextWithTrace(input: string): Promise<AssistantResponse> {
    const trimmed = input.trim();
    const trace: string[] = [];

    if (!trimmed) {
      return { reply: 'Bitte sende eine Nachricht.', trace };
    }

    if (trimmed.startsWith('/ha ') || trimmed.startsWith('/mcp ')) {
      const instruction = trimmed.replace(/^\/(?:ha|mcp)\s+/i, '').trim();
      if (!instruction) {
        return {
          reply: 'Nutzung: /mcp <Anweisung>, z. B. /mcp mach den Schreibtisch aus',
          trace,
        };
      }

      logger.info({ instruction }, 'Received explicit MCP instruction');
      trace.push('route: explicit_mcp');
      if (instruction === 'tools' || instruction === 'help') {
        const result = await mcpHostService.runTool('tools');
        logger.info({ ok: result.ok }, 'Completed MCP tools listing');
        trace.push('action: tools_list');
        return { reply: result.output, trace };
      }

      const response = await this.runMcpSkill(instruction, true, trace);
      logger.info('Completed explicit MCP skill execution');
      return { reply: response, trace };
    }

    const route = await this.decideRoute(trimmed);
    logger.info({ route }, 'Auto route decision');
    trace.push(`route: ${route}`);
    if (route === 'mcp') {
      const response = await this.runMcpSkill(trimmed, false, trace);
      return { reply: response, trace };
    }

    trace.push('execution_path: chat');
    const reply = await ollamaService.generate(CHAT_SYSTEM_PROMPT, trimmed);
    return { reply, trace };
  }

  async handleText(input: string): Promise<string> {
    const result = await this.handleTextWithTrace(input);
    return result.reply;
  }
}

export const assistant = new Assistant();
