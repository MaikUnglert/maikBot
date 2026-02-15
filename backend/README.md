# maikBot Backend (New)

Secure minimal backend for:
- Telegram bot via long polling (no direct internet inbound port)
- Local Ollama responses
- Optional multi-MCP tool calls (e.g. Home Assistant, Paperless)

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
- Natural language request: router decides between chat and MCP tools
- `/mcp tools` (or `/ha tools`): list available MCP tools across configured servers
- `/mcp <request>` (or `/ha <request>`): force MCP path

Example:
```text
Mach den Schreibtisch aus
/mcp turn off desk light
/mcp tools
```

## 4. Security Notes

- Telegram uses long polling, so no webhook port is required.
- Set `ALLOWED_TELEGRAM_USER_IDS`, otherwise any Telegram user with bot access can use it.
- Keep `OLLAMA_BASE_URL` reachable only from internal networks.
- Use MCP servers only with authentication (`MCP_SERVERS_JSON` / `HA_MCP_API_KEY`).
- Optional guardrails via `MCP_TOOL_POLICY_JSON` (allow/deny tools, require explicit `/mcp` for selected tools).

## 5. Smoke Tests

Check if the Ollama container/API is reachable:

```bash
npm run test:ollama:reachability
```

Send one chat request to Ollama (`/api/chat`) and verify a model response:

```bash
npm run test:ollama:chat
```

Check if Home Assistant is reachable from the backend host:

```bash
npm run test:ha:reachability
```

List available Home Assistant MCP tools:

```bash
npm run test:ha:mcp-tools
```
