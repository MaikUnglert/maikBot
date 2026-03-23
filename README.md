# maikBot

AI assistant via Telegram (and optional WhatsApp). LLM: Gemini, Ollama, or NVIDIA NIM. Tools: MCP (Home Assistant), shell, browser, scheduling.

## Quick Start

```bash
cd backend
npm install
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_USER_IDS, GEMINI_API_KEY
npm run dev
```

## systemd (Debian/Ubuntu VM)

For production with auto-restart (e.g. after `/update`):

```bash
sudo ./setup-systemd.sh --install
sudo systemctl start maikbot
```

Without `--install` the script only shows the service file. Logs: `journalctl -u maikbot -f`

## Commands

| Command | Description |
|---------|-------------|
| `/model` | Show current LLM |
| `/model gemini` \| `/model ollama` \| `/model nvidia` | Switch LLM |
| `/update` | Pull updates, build, restart (needs systemd/PM2) |
| `/reload` | Build and restart only (for Gemini CLI self-improvements, no git pull) |
| `/clear` | Reset chat |
| `/status` | Context stats |
| `/mcp tools` | List MCP tools |
| `/scan` | Scan document (see Scan → Paperless below) |

## Self-update & Self-improvement

Chat history is persisted to disk (`data/chat-sessions/`) and survives restarts.

**Natural language:** Ask the bot to update itself (e.g. "update dich", "aktualisiere dich") – it uses `shell_exec` for git pull, build, then tells you to run `/update` or restart.

**`/update`:** Full flow: persist chat, git pull, npm install, npm run build, exit. A process manager (systemd, PM2) restarts the bot.

**`/reload`:** Build and restart only – for local changes from Gemini CLI (avoids git pull overwriting edits).

**Self-improvement via Gemini CLI:** Ask the bot to improve itself (e.g. "verbessere dich: füge X hinzu"). It delegates to Gemini CLI with instructions to create a feature branch, make changes, commit, push, and open a PR. Never commits to main. After you merge the PR, run `/update`.

**Iterations:** When you ask to change a previous Gemini result (e.g. "change that to X"), the bot uses `continue_session=true` to resume the same Gemini CLI session.

## External repos (Git workspace)

When you ask the bot to work on an external repo (e.g. "clone X and add feature Y"), it clones into `data/repos/` and delegates to Gemini CLI with that workspace. Configure `GIT_REPOS_DIR` if needed (must be under `GEMINI_CLI_WORKSPACE_ROOT`).

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
