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

`/scan` funktioniert in **Telegram** und **WhatsApp**. Startet Scan am Drucker (HP WebScan) oder per SANE/scanimage. Mehrere Seiten möglich:

- **/scan** – Seite scannen (oder erste Seite)
- **/scan** – weitere Seite hinzufügen
- **/scan done** – fertig: PDF-Vorschau, dann Bestätigung
- **/scan cancel** – Session abbrechen

**Telegram:** Vorschau mit Inline-Buttons „Zu Paperless senden“ / „Verwerfen“, oder „ja“/„nein“ tippen.  
**WhatsApp:** Vorschau als Dokument, dann antworte mit „ja“ oder „nein“.

**PDF-Upload:** PDF als Datei schicken (Telegram/WhatsApp) → Bot fragt, ob zu Paperless senden. Bestätigen mit Button oder „ja“.

Voraussetzung: `SCAN_BACKEND=hp-webscan` + `SCAN_HP_PRINTER_IP` oder `SCAN_BACKEND=scanimage` (SANE/airscan). Paperless: `PAPERLESS_URL` + `PAPERLESS_TOKEN`.

## Paperless-ngx document classification

When `PAPERLESS_URL` and `PAPERLESS_TOKEN` are set, maikBot runs an HTTP webhook server that automatically classifies newly consumed documents (tags, correspondent, document type) using the LLM. Inspired by [Paperless-AI](https://github.com/clusterzx/paperless-ai).

1. Add to `.env`:
   ```
   PAPERLESS_URL=http://192.168.178.96:8000
   PAPERLESS_TOKEN=your_api_token
   PAPERLESS_CLASSIFY_PORT=3080
   ```

2. **Paperless integration** – choose one:

   **A) Post-consumption script (empfohlen):**

   - Script auf Paperless-Server: `scripts/paperless-post-consume.sh`
   - `MAIKBOT_URL` im Script setzen (z.B. `http://192.168.178.40:3080`)
   - `chmod +x paperless-post-consume.sh`
   - **Docker:** In `docker-compose.yml`:
     ```yaml
     environment:
       POST_CONSUME_SCRIPT: /usr/src/paperless/scripts/paperless-post-consume.sh
     volumes:
       - ./paperless-post-consume.sh:/usr/src/paperless/scripts/paperless-post-consume.sh:ro
     ```

   **B) Workflow-Webhook (Paperless 2.14+):** Platzhalter wie `{doc_url}` werden in manchen Versionen nicht ersetzt. Wenn das Script nicht möglich ist:
   - Verwaltung → Arbeitsabläufe → neuer Workflow
   - Auslöser: „Dokument hinzugefügt“, Aktion: Webhook
   - URL: `http://<maikbot-host>:3080/api/paperless-classify?doc_url={doc_url}` (oder Body mit doc_url)
