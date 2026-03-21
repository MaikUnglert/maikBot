import { config } from '../../config.js';
import { llmService } from '../../services/llm.service.js';
import type { ToolDefinition } from '../../services/llm.types.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

const ALLOWED_KEYS = new Set([
  'llm_provider',
  'ollama_model',
  'gemini_model',
  'nvidia_model',
]);

export function getAgentConfigTools(): {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}[] {
  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'agent_config_get',
          description:
            'Get current agent configuration (LLM provider, model names). Use when the user asks about settings or "what model are you using".',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async () => {
        const provider = llmService.modelLabel;
        return {
          ok: true,
          output: `Current: ${provider}\n\nConfig:\n- llm_provider: ${config.defaultLlmProvider}\n- ollama_model: ${config.ollamaModel}\n- gemini_model: ${config.geminiModel}\n- nvidia_model: ${config.nvidiaModel}`,
        };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'agent_config_set',
          description:
            'Change agent configuration at runtime. Use when the user asks to switch model or provider (e.g. "use Gemini", "switch to Ollama"). Only affects current session until restart.',
          parameters: {
            type: 'object',
            required: ['key'],
            properties: {
              key: {
                type: 'string',
                enum: ['llm_provider', 'ollama_model', 'gemini_model', 'nvidia_model'],
                description:
                  'Config key to set.',
              },
              value: {
                type: 'string',
                description: 'New value. For llm_provider: ollama, gemini, or nvidia. For model keys: model name.',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const key = typeof args.key === 'string' ? args.key : '';
        const value = typeof args.value === 'string' ? args.value : '';
        if (!ALLOWED_KEYS.has(key)) {
          return { ok: false, output: `Key "${key}" is not allowed. Allowed: ${[...ALLOWED_KEYS].join(', ')}` };
        }
        if (key === 'llm_provider') {
          const v = value.toLowerCase();
          if (!['ollama', 'gemini', 'nvidia'].includes(v)) {
            return { ok: false, output: 'llm_provider must be ollama, gemini, or nvidia.' };
          }
          llmService.switchProvider(v as 'ollama' | 'gemini' | 'nvidia');
          return { ok: true, output: `Switched to ${llmService.modelLabel}.` };
        }
        if (key === 'ollama_model') {
          config.ollamaModel = value;
          if (config.defaultLlmProvider === 'ollama') {
            return { ok: true, output: `Ollama model set to ${value}. Active on next request.` };
          }
          return { ok: true, output: `Ollama model set to ${value}. (Active provider is ${config.defaultLlmProvider}; switch with agent_config_set llm_provider ollama)` };
        }
        if (key === 'gemini_model') {
          config.geminiModel = value;
          if (config.defaultLlmProvider === 'gemini') {
            return { ok: true, output: `Gemini model set to ${value}. Active on next request.` };
          }
          return { ok: true, output: `Gemini model set to ${value}. (Active provider is ${config.defaultLlmProvider})` };
        }
        if (key === 'nvidia_model') {
          config.nvidiaModel = value;
          if (config.defaultLlmProvider === 'nvidia') {
            return { ok: true, output: `NVIDIA model set to ${value}. Active on next request.` };
          }
          return { ok: true, output: `NVIDIA model set to ${value}. (Active provider is ${config.defaultLlmProvider})` };
        }
        return { ok: false, output: 'Unknown key.' };
      },
    },
  ];
}
