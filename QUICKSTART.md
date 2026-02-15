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

Optional for MCP skill backend (currently Home Assistant):
- `HA_MCP_BASE_URL`
- `HA_MCP_API_KEY`
- `HA_MCP_TOOL_NAME`

## 3. Start

```bash
npm run dev
```

## 4. Usage

- Regular Telegram message to the bot: response from Ollama
- `/ha <instruction>`: calls the MCP connector (currently mapped to Home Assistant skill)

Example:
```text
/ha turn on the living room light
```

## 5. Security Checks

1. Ollama port reachable only internally (no WAN port forwarding).
2. Allowlist configured (`ALLOWED_TELEGRAM_USER_IDS`).
3. MCP endpoint is internal and authenticated.
