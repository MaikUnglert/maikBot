# maikBot Backend

Secure backend for the maikBot Telegram assistant.

## Setup

```bash
npm install
cp .env.example .env   # fill in values
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm run start` | Run compiled JS |
| `npm run check` | Type-check without emitting |
| `npm run test:shell` | Shell tool unit tests |
| `npm run test:registry` | Tool registry tests |
| `npm run test:ollama:reachability` | Ollama connectivity test |
| `npm run test:ollama:chat` | Ollama chat test |
| `npm run test:ha:reachability` | Home Assistant connectivity test |
| `npm run test:ha:mcp-tools` | MCP tools list test |

## Configuration

All configuration via environment variables. See `.env.example` for full reference.

Key variables:
- `LLM_PROVIDER` — `gemini` (default) or `ollama`
- `GEMINI_API_KEY` — Google AI Studio API key
- `GEMINI_MODEL` — Model name (default: `gemini-2.5-flash`)
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL` — Local Ollama config
- `TELEGRAM_BOT_TOKEN` / `ALLOWED_TELEGRAM_USER_IDS` — Telegram config
- `MCP_SERVERS_JSON` — MCP server configuration
