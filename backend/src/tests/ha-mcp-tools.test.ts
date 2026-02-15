import 'dotenv/config';

interface JsonRpcResponse<T = unknown> {
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface ToolsListResult {
  tools?: Array<{ name: string }>;
}

function getEnv(name: string, fallback = ''): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const baseUrl = getEnv('HA_MCP_BASE_URL');
  const apiKey = getEnv('HA_MCP_API_KEY');

  if (!baseUrl) {
    console.error('[FAIL] HA_MCP_BASE_URL is not set');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('[FAIL] HA_MCP_API_KEY is not set');
    process.exit(1);
  }

  const targetUrl = baseUrl.endsWith('/api/mcp') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/mcp`;
  const startedAt = Date.now();

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const body = await response.text();
    console.error(`[FAIL] tools/list failed in ${durationMs}ms: HTTP ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  const data = (await response.json()) as JsonRpcResponse<ToolsListResult>;
  if (data.error) {
    console.error(`[FAIL] tools/list JSON-RPC error: ${data.error.code} ${data.error.message}`);
    process.exit(1);
  }

  const tools = data.result?.tools ?? [];
  console.log(`[OK] MCP tools/list succeeded in ${durationMs}ms`);
  console.log(`Found tools: ${tools.length}`);
  console.log(tools.slice(0, 20).map((tool) => `- ${tool.name}`).join('\n'));
  process.exit(0);
}

void main();
