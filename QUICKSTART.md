# maikBot Quickstart

## 1. Install

```bash
cd backend
npm install
cp .env.example .env
```

## 2. Configure `.env`

Required:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `GEMINI_API_KEY` — from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- `ALLOWED_TELEGRAM_USER_IDS` — your Telegram user ID

Optional (Home Assistant):
- `MCP_SERVERS_JSON` or `HA_MCP_BASE_URL` + `HA_MCP_API_KEY`

Optional (local Ollama fallback):
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL`

## 3. Start

```bash
npm run dev
```

## 4. Usage

Send messages to the bot on Telegram. It responds using the active LLM provider (default: Gemini).

Commands:
- `/model` — show current provider
- `/model gemini` / `/model ollama` — switch provider
- `/clear` — reset conversation history
- `/status` — show context stats
- `/mcp tools` — list available MCP tools

## 5. Smoke Tests

```bash
npm run test:ollama:reachability
npm run test:ollama:chat
npm run test:ha:reachability
npm run test:ha:mcp-tools
npm run test:shell
npm run test:registry
```
