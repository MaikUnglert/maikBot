# WhatsApp Channel

maikBot can receive and send messages via WhatsApp in addition to Telegram, using the [Baileys](https://github.com/WhiskeySockets/Baileys) library (WhatsApp Web protocol). This follows a similar approach to [OpenClaw](https://docs.openclaw.ai/channels/whatsapp).

## How It Works

- **WhatsApp Web**: Baileys connects to WhatsApp servers via WebSocket (outbound only; no inbound ports).
- **QR Code / Pairing**: First-time setup requires scanning a QR code or using a pairing code to link your phone.
- **Session persistence**: Auth credentials are stored in `data/whatsapp-auth/` so you typically only need to link once.

## Enable WhatsApp

1. Set in `.env`:
   ```
   WHATSAPP_ENABLED=true
   # Only you (self-chat): no allowlist needed
   WHATSAPP_SELF_ONLY=true
   # Or use allowlist for multiple contacts:
   # WHATSAPP_ALLOWED_FROM=+491234567890
   ```

2. Start the backend. On first run, a QR code appears in the terminal.

3. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → Scan the QR code.

4. Once linked, the bot is ready. To chat:
   - **"Message to yourself" / "Nachrichten an dich"**: Tap **New Chat** → **"Message Yourself"** (or your name). Send there. Or open `https://wa.me/+49YOURNUMBER` in a browser.
   - Ensure your number is in `WHATSAPP_ALLOWED_FROM` (or `WHATSAPP_SELF_ONLY=true`). Set `LOG_LEVEL=debug` to trace incoming messages.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_ENABLED` | `false` | Enable the WhatsApp channel |
| `WHATSAPP_AUTH_DIR` | `data/whatsapp-auth` | Directory for session credentials |
| `WHATSAPP_ALLOWED_FROM` | (empty) | Comma-separated E.164 numbers (e.g. `+491234567890`). Use `*` for open (not recommended) |
| `WHATSAPP_ALLOW_EMPTY_ALLOWLIST` | `false` | Allow all when allowlist is empty (dangerous) |
| `WHATSAPP_PRINT_QR` | `true` | Print QR code in terminal for linking |
| `WHATSAPP_GROUPS_ENABLED` | `false` | Allow group chats (group participants must be in allowlist) |
| `WHATSAPP_SELF_ONLY` | `false` | Only process "Message to yourself"; ignore all other senders |

## Access Control

- **`WHATSAPP_SELF_ONLY=true`**: Only "Message to yourself" is processed. All other messages are ignored (no response).
- **`WHATSAPP_SELF_ONLY=false`**: Only numbers in `WHATSAPP_ALLOWED_FROM` can talk to the bot. Others get "Access denied."
- **Groups**: If `WHATSAPP_GROUPS_ENABLED=true`, the bot responds in groups when the sender is in the allowlist.
- **Security**: Prefer a dedicated phone number for the bot (like OpenClaw recommends). Using your personal number with `WHATSAPP_SELF_ONLY=true` gives a private bot-only chat.

## Channel Routing

Scheduled reminders and Gemini CLI job reviews are delivered to the correct channel (Telegram or WhatsApp) based on where the user created the task. Session IDs are stored as `tg:12345` (Telegram) or `wa:49123@s.whatsapp.net` (WhatsApp).

## Troubleshooting

- **QR code not showing**: Ensure `WHATSAPP_PRINT_QR=true` and your terminal supports QR rendering.
- **Connection drops**: Baileys may disconnect. The bot auto-reconnects unless you logged out.
- **"Not in allowlist"**: Add your number to `WHATSAPP_ALLOWED_FROM` (with country code, e.g. `+49` for Germany).
- **Telegram 409 / WhatsApp "connection replaced"**: Only one maikBot instance can run. The bot uses a lockfile (`data/.maikbot.lock`) to prevent duplicates. If you see these errors, stop all maikBot processes and wait ~30 seconds before starting again.
