# maikBot Quickstart (Telegram + Ollama + MCP)

## 1. Install Backend

```bash
cd /home/maik/Projects/maikBot/backend
npm install
cp .env.example .env
```

## 2. Configure `.env`

Required:
- `TELEGRAM_BOT_TOKEN`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`

Recommended:
- `ALLOWED_TELEGRAM_USER_IDS` (your Telegram user ID)

Optional for Home Assistant MCP server:
- `HA_MCP_BASE_URL`
- `HA_MCP_API_KEY`

## 3. Start

```bash
npm run dev
```

## 4. Usage

- Regular Telegram message to the bot: response from Ollama
- `/ha tools`: lists available Home Assistant MCP tools
- `/ha on <name>` and `/ha off <name>`: convenience tool calls
- `/ha <ToolName> <JSON args>`: direct MCP tool call

Example:
```text
/ha on kitchen light
/ha HassLightSet {"name":"kitchen light","brightness":60}
```

## 5. Security Checks

1. Ollama port reachable only internally (no WAN port forwarding).
2. Allowlist configured (`ALLOWED_TELEGRAM_USER_IDS`).
3. Home Assistant MCP endpoint (`/api/mcp`) is internal and authenticated.
