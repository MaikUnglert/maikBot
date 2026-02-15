# maikBot Backend (New)

Secure minimal backend for:
- Telegram bot via long polling (no direct internet inbound port)
- Local Ollama responses
- Optional MCP skill tool calls via `/ha ...` (currently mapped to Home Assistant)

## 1. Setup

```bash
cd backend
npm install
cp .env.example .env
```

Then fill in `.env`.

## 2. Start

```bash
npm run dev
```

## 3. Use Telegram

- Regular message: goes to Ollama
- `/ha <instruction>`: goes to the MCP connector (currently Home Assistant skill)

Example:
```text
/ha turn on the living room light
```

## 4. Security Notes

- Telegram uses long polling, so no webhook port is required.
- Set `ALLOWED_TELEGRAM_USER_IDS`, otherwise any Telegram user with bot access can use it.
- Keep `OLLAMA_BASE_URL` reachable only from internal networks.
- Use MCP only with authentication (for current setup: `HA_MCP_API_KEY`).

## 5. Smoke Tests

Check if the Ollama container/API is reachable:

```bash
npm run test:ollama:reachability
```

Send one chat request to Ollama (`/api/chat`) and verify a model response:

```bash
npm run test:ollama:chat
```
