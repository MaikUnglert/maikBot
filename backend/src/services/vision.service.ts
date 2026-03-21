/**
 * Vision service: analyzes images via Gemini or Ollama LLaVA.
 * Returns text descriptions for agent consumption.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

export const VISION_PROMPT_WEB_PAGE = `Describe this web page screenshot for an AI agent that needs to interact with it. Include:
- Page title and main purpose
- Visible text, headings, and content
- Buttons, links, and form fields (with labels or placeholders)
- Layout and structure

Be concise but thorough. List interactive elements with enough detail to construct CSS selectors (e.g. "Search button", "input labeled 'Email'").`;

export const VISION_PROMPT_GENERAL = `Describe this image in detail. Include:
- Main subject and context
- Text visible in the image (if any)
- Layout, colors, notable elements
- Anything that might be relevant for answering questions about the image.`;

export interface VisionResult {
  ok: boolean;
  description: string;
}

async function analyzeWithGemini(imageBase64: string, mimeType: string, prompt: string): Promise<string> {
  const apiKey = config.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const model = config.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: mimeType === 'png' ? 'image/png' : 'image/jpeg',
              data: imageBase64,
            },
          },
          { text: prompt },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.geminiTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini vision HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(data.error.message);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim() || '(No description returned)';
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeWithOllama(imageBase64: string, prompt: string): Promise<string> {
  const visionModel = config.ollamaVisionModel ?? 'llava';
  const url = `${config.ollamaBaseUrl}/api/chat`;

  const body = {
    model: visionModel,
    messages: [
      {
        role: 'user',
        content: prompt,
        images: [imageBase64],
      },
    ],
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.browserTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama vision HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };

    return (data.message?.content ?? '').trim() || '(No description returned)';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Analyze an image and return a text description.
 * Uses Gemini if API key is set, otherwise Ollama with a vision model.
 * @param prompt - Custom prompt for the vision model. Defaults to general image description.
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  mimeType: string = 'image/png',
  prompt: string = VISION_PROMPT_GENERAL
): Promise<VisionResult> {
  const base64 = imageBuffer.toString('base64');

  try {
    let description: string;

    if (config.geminiApiKey) {
      logger.debug('Using Gemini for vision');
      description = await analyzeWithGemini(base64, mimeType, prompt);
    } else if (config.ollamaBaseUrl) {
      logger.debug('Using Ollama for vision');
      description = await analyzeWithOllama(base64, prompt);
    } else {
      return {
        ok: false,
        description: 'No vision provider configured. Set GEMINI_API_KEY or OLLAMA_BASE_URL.',
      };
    }

    return { ok: true, description };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Vision analysis failed');
    return { ok: false, description: `Vision analysis failed: ${msg}` };
  }
}
