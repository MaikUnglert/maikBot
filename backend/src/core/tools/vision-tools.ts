/**
 * Vision tools: analyze images from file path or buffer.
 * Works with user-sent Telegram photos (when handler passes path) and any local image.
 */
import { readFile } from 'node:fs/promises';
import { config } from '../../config.js';
import { analyzeImage } from '../../services/vision.service.js';
import type { ToolDefinition } from '../../services/llm.types.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

function isVisionAvailable(): boolean {
  return !!(config.geminiApiKey || config.ollamaBaseUrl);
}

export function getVisionTools(): {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}[] {
  if (!isVisionAvailable()) {
    return [];
  }

  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'vision_analyze_image',
          description:
            'Analyze an image from a file path. Returns a text description. Use when the user sends an image, references an image file, or when you need to understand visual content. Supports PNG, JPEG, WebP.',
          parameters: {
            type: 'object',
            required: ['path'],
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path to the image file (e.g. /tmp/maikbot/photo.jpg)',
              },
              prompt: {
                type: 'string',
                description:
                  'Optional custom prompt for the vision model. E.g. "What text is in this image?" or "Describe the error message shown."',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        if (!path) {
          return { ok: false, output: 'path is required.' };
        }
        const customPrompt =
          typeof args.prompt === 'string' ? args.prompt.trim() || undefined : undefined;

        try {
          const buf = await readFile(path);
          const ext = path.toLowerCase().split('.').pop();
          const mimeType =
            ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

          const result = await analyzeImage(buf, mimeType, customPrompt);

          if (!result.ok) {
            return { ok: false, output: result.description };
          }

          return {
            ok: true,
            output: result.description,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, output: `Failed to read or analyze image: ${msg}` };
        }
      },
    },
  ];
}
