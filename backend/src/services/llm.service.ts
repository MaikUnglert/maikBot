import { config, type LlmProviderName } from '../config.js';
import { logger } from '../logger.js';
import { ollamaService } from './ollama.service.js';
import { geminiService } from './gemini.service.js';
import { nvidiaService } from './nvidia.service.js';
import type { LlmProvider, LlmMessage, ToolDefinition, ChatResult } from './llm.types.js';

const providers: Record<LlmProviderName, LlmProvider> = {
  ollama: ollamaService,
  gemini: geminiService,
  nvidia: nvidiaService,
};

class LlmService implements LlmProvider {
  private activeProvider: LlmProviderName = config.defaultLlmProvider;

  get name(): string {
    return this.activeProvider;
  }

  get modelLabel(): string {
    if (this.activeProvider === 'gemini') return `gemini (${config.geminiModel})`;
    if (this.activeProvider === 'nvidia') return `nvidia (${config.nvidiaModel})`;
    return `ollama (${config.ollamaModel})`;
  }

  getActiveProviderName(): LlmProviderName {
    return this.activeProvider;
  }

  getAvailableProviders(): LlmProviderName[] {
    return Object.keys(providers) as LlmProviderName[];
  }

  switchProvider(name: LlmProviderName): void {
    if (!providers[name]) {
      throw new Error(`Unknown LLM provider: ${name}. Available: ${this.getAvailableProviders().join(', ')}`);
    }
    const previous = this.activeProvider;
    this.activeProvider = name;
    logger.info({ from: previous, to: name }, 'LLM provider switched');
  }

  chat(messages: LlmMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    return providers[this.activeProvider].chat(messages, tools);
  }

  healthCheck(): Promise<boolean> {
    return providers[this.activeProvider].healthCheck();
  }

  async healthCheckAll(): Promise<Record<LlmProviderName, boolean>> {
    const results: Partial<Record<LlmProviderName, boolean>> = {};
    for (const [name, provider] of Object.entries(providers)) {
      results[name as LlmProviderName] = await provider.healthCheck();
    }
    return results as Record<LlmProviderName, boolean>;
  }
}

export const llmService = new LlmService();
