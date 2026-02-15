import 'dotenv/config';

function getEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const ollamaBaseUrl = getEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').replace(/\/$/, '');
  const timeoutMs = Number.parseInt(getEnv('OLLAMA_TIMEOUT_MS', '5000'), 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 5000);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text();
      console.error(`[FAIL] Ollama reachable test failed in ${durationMs}ms`);
      console.error(`URL: ${ollamaBaseUrl}/api/tags`);
      console.error(`HTTP ${response.status}: ${body}`);
      process.exit(1);
    }

    console.log(`[OK] Ollama reachable in ${durationMs}ms`);
    console.log(`URL: ${ollamaBaseUrl}/api/tags`);
    process.exit(0);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] Ollama reachable test failed in ${durationMs}ms`);
    console.error(`URL: ${ollamaBaseUrl}/api/tags`);
    console.error(`Error: ${message}`);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
