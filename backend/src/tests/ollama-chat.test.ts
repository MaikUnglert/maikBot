import 'dotenv/config';

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

function getEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const ollamaBaseUrl = getEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = getEnv('OLLAMA_MODEL', 'llama3.2:latest');
  const timeoutMs = Number.parseInt(getEnv('OLLAMA_TIMEOUT_MS', '30000'), 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 30000);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
      }),
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text();
      console.error(`[FAIL] Ollama chat test failed in ${durationMs}ms`);
      console.error(`URL: ${ollamaBaseUrl}/api/chat`);
      console.error(`Model: ${model}`);
      console.error(`HTTP ${response.status}: ${body}`);
      process.exit(1);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim();

    if (!content) {
      console.error(`[FAIL] Ollama chat test failed in ${durationMs}ms`);
      console.error('No response content received from model.');
      process.exit(1);
    }

    console.log(`[OK] Ollama chat test succeeded in ${durationMs}ms`);
    console.log(`Model: ${model}`);
    console.log(`Response: ${content}`);
    process.exit(0);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] Ollama chat test failed in ${durationMs}ms`);
    console.error(`URL: ${ollamaBaseUrl}/api/chat`);
    console.error(`Model: ${model}`);
    console.error(`Error: ${message}`);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
