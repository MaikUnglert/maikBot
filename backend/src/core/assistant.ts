import { homeAssistantMcpService } from '../services/home-assistant-mcp.service.js';
import { ollamaService } from '../services/ollama.service.js';

const SYSTEM_PROMPT = `You are MaikBot, a local AI assistant.
Rules:
1) Respond briefly and clearly in English.
2) Do not invent device states.
3) If the user starts with "/ha ", Home Assistant is called via MCP.
4) On errors, provide concrete next steps.`;

export class Assistant {
  async handleText(input: string): Promise<string> {
    const trimmed = input.trim();

    if (!trimmed) {
      return 'Please send a message.';
    }

    if (trimmed.startsWith('/ha ')) {
      const instruction = trimmed.slice(4).trim();
      if (!instruction) {
        return 'Use /ha <instruction>, for example: /ha turn on the living room light';
      }

      const result = await homeAssistantMcpService.runTool(instruction);
      return result.output;
    }

    return ollamaService.generate(SYSTEM_PROMPT, trimmed);
  }
}

export const assistant = new Assistant();
