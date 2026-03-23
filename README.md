# maikBot

AI assistant via Telegram (and optional WhatsApp). LLM: Gemini, Ollama, or NVIDIA NIM. Tools: MCP (Home Assistant), shell, browser, scheduling.

## Quick Start

```bash
cd backend
npm install
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_USER_IDS, GEMINI_API_KEY
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `/model` | Show current LLM |
| `/model gemini` \| `/model ollama` \| `/model nvidia` | Switch LLM |
| `/clear` | Reset chat |
| `/status` | Context stats |
| `/mcp tools` | List MCP tools |

## .env essentials

- `TELEGRAM_BOT_TOKEN` — @BotFather
- `ALLOWED_TELEGRAM_USER_IDS` — your Telegram ID
- `GEMINI_API_KEY` — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — or `OLLAMA_BASE_URL` for local Ollama — or `NVIDIA_API_KEY` for [NVIDIA NIM](https://build.nvidia.com)

See `backend/.env.example` for full options.

## Scan → Paperless

`/scan` works in **Telegram** and **WhatsApp**. Starts a scan from the printer (HP WebScan) or via SANE/scanimage. Multiple pages are supported:

- **/scan** – scan a page (or the first page)
- **/scan** – add another page
- **/scan done** – finish: PDF preview, then confirmation
- **/scan cancel** – cancel the session

**Telegram:** Preview with inline buttons “Send to Paperless” / “Discard”, or type **yes** / **no** (also **ja** / **nein**, **send**, **ok**, etc.).  
**WhatsApp:** Preview as a document, then reply with **yes** or **no** (same alternatives as Telegram).

**PDF upload:** Send a PDF as a file (Telegram/WhatsApp) → the bot asks whether to send it to Paperless. Confirm with the button or **yes** / **ja** / **ok**.

Requirements: `SCAN_BACKEND=hp-webscan` + `SCAN_HP_PRINTER_IP`, or `SCAN_BACKEND=scanimage` (SANE/airscan). For Paperless: `PAPERLESS_URL` + `PAPERLESS_TOKEN`.

## Paperless-ngx document classification

When `PAPERLESS_URL` and `PAPERLESS_TOKEN` are set, maikBot runs an HTTP webhook server that automatically classifies newly consumed documents (tags, correspondent, document type) using the LLM. Inspired by [Paperless-AI](https://github.com/clusterzx/paperless-ai).

1. Add to `.env`:
   ```
   PAPERLESS_URL=http://192.168.178.96:8000
   PAPERLESS_TOKEN=your_api_token
   PAPERLESS_CLASSIFY_PORT=3080
   ```

2. **Paperless integration** – choose one:

   **A) Post-consumption script (recommended):**

   - Script on the Paperless host: `scripts/paperless-post-consume.sh`
   - Set `MAIKBOT_URL` in the script (e.g. `http://192.168.178.40:3080`)
   - `chmod +x paperless-post-consume.sh`
   - **Docker:** In `docker-compose.yml`:
     ```yaml
     environment:
       POST_CONSUME_SCRIPT: /usr/src/paperless/scripts/paperless-post-consume.sh
     volumes:
       - ./paperless-post-consume.sh:/usr/src/paperless/scripts/paperless-post-consume.sh:ro
     ```

   **B) Workflow webhook (Paperless 2.14+):** Placeholders such as `{doc_url}` are not substituted in some versions. If the post-consumption script is not an option:
   - Administration → Workflows → new workflow
   - Trigger: “Document added”, action: Webhook
   - URL: `http://<maikbot-host>:3080/api/paperless-classify?doc_url={doc_url}` (or pass `doc_url` in the request body)
