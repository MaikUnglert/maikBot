# Deploying maikBot on Proxmox

This guide describes how to deploy maikBot on a Proxmox host (LXC container or VM).

## Prerequisites

- Proxmox host with network access to:
  - Internet (Telegram, optional: Gemini API, WhatsApp)
  - Your local network (Ollama, Home Assistant if used)
- Node.js 22+ (LTS recommended)
- Optional: Playwright Chromium (only if `BROWSER_ENABLED=true`)

## Option A: LXC Container (recommended)

1. **Create an LXC container**
   - Template: Ubuntu 24.04 or Debian 12
   - Resources: 1 vCPU, 512 MB RAM minimum (1 GB if using browser tool)
   - Network: Bridged or NAT with port forwarding if needed (Telegram uses outbound only; no inbound ports required for long polling)

2. **Start the container and install Node.js**
   ```bash
   apt update && apt install -y curl
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt install -y nodejs
   node -v   # should show v22.x
   ```

3. **Create a non-root user (recommended)**
   ```bash
   adduser --disabled-password --gecos "" maikbot
   su - maikbot
   ```

4. **Clone the repository**
   ```bash
   cd ~
   git clone <your-repo-url> maikBot
   cd maikBot/backend
   ```

5. **Install dependencies**
   ```bash
   npm ci
   ```

6. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your tokens and settings
   nano .env
   ```
   Required at minimum: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS`, and either `GEMINI_API_KEY` or `OLLAMA_BASE_URL` (pointing to your Ollama instance).

7. **Optional: Install Playwright Chromium (only if BROWSER_ENABLED=true)**
   ```bash
   npx playwright install chromium
   npx playwright install-deps chromium   # if dependencies fail
   ```

8. **Build and run**
   ```bash
   npm run build
   npm run start
   ```

9. **Run as a systemd service** (for automatic start and restart)
   Create `/etc/systemd/system/maikbot.service`:
   ```ini
   [Unit]
   Description=maikBot Backend
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=maikbot
   Group=maikbot
   WorkingDirectory=/home/maikbot/maikBot/backend
   ExecStart=/usr/bin/node dist/index.js
   Restart=on-failure
   RestartSec=10
   Environment=NODE_ENV=production
   # Load .env from WorkingDirectory
   EnvironmentFile=/home/maikbot/maikBot/backend/.env

   [Install]
   WantedBy=multi-user.target
   ```
   Then:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable maikbot
   sudo systemctl start maikbot
   sudo systemctl status maikbot
   ```

## Option B: VM

Same steps as Option A, but inside a VM instead of LXC. Use Ubuntu Server or Debian minimal.

## Data persistence

The following directories are used at runtime and should persist across updates:

| Path | Purpose |
|------|---------|
| `data/memory/` | Agent memory (learned notes) |
| `data/scheduler/` | Scheduled tasks (reminders, jobs) |
| `data/jobs/` | Gemini CLI job state |
| `data/shell-jobs/` | Async shell job output |
| `data/whatsapp-auth/` | WhatsApp Baileys session (if WhatsApp enabled) |

Do not delete these directories when pulling updates. Back them up before major upgrades.

## Network considerations

- **Telegram**: Uses long polling (outbound only). No inbound ports or webhooks needed.
- **WhatsApp**: Baileys connects outbound to WhatsApp servers. No inbound ports.
- **Ollama**: Ensure `OLLAMA_BASE_URL` is reachable from the container (e.g. `http://192.168.1.100:11434`).
- **Home Assistant / MCP**: Ensure the MCP server URL is reachable from the container.
- **Gemini API**: Cloud-only; requires outbound HTTPS.

## Updates

```bash
cd ~/maikBot
git pull
cd backend
npm ci
npm run build
sudo systemctl restart maikbot
```

## Troubleshooting

- **Bot does not respond**: Check `TELEGRAM_BOT_TOKEN` and `ALLOWED_TELEGRAM_USER_IDS`. Ensure your user ID is in the allowlist.
- **Ollama unreachable**: Verify `OLLAMA_BASE_URL` from inside the container (`curl http://<host>:11434/api/tags`).
- **WhatsApp QR not showing**: Run in foreground first (`npm run start`) to see QR in logs; copy session from `data/whatsapp-auth/` after pairing.
- **Logs**: `journalctl -u maikbot -f` when using systemd.
