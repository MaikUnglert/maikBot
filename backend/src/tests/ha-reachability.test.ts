import 'dotenv/config';

function getEnv(name: string, fallback = ''): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const baseUrl = getEnv('HA_MCP_BASE_URL');
  const apiKey = getEnv('HA_MCP_API_KEY');
  const timeoutMs = Number.parseInt(getEnv('OLLAMA_TIMEOUT_MS', '8000'), 10);

  if (!baseUrl) {
    console.error('[FAIL] HA_MCP_BASE_URL is not set');
    process.exit(1);
  }

  const sanitizedBase = baseUrl.replace(/\/$/, '');
  const targetUrl = sanitizedBase.endsWith('/api/mcp') ? sanitizedBase : `${sanitizedBase}/api/mcp`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 8000);
  const startedAt = Date.now();

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'maikbot-backend-test', version: '0.1.0' },
        },
      }),
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;
    console.log(`[OK] Home Assistant reachable in ${durationMs}ms`);
    console.log(`URL: ${targetUrl}`);
    console.log(`HTTP: ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      console.log('Auth required or denied, but MCP endpoint reachability is confirmed.');
    }
    process.exit(0);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] Home Assistant reachability test failed in ${durationMs}ms`);
    console.error(`URL: ${targetUrl}`);
    console.error(`Error: ${message}`);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
