# maikBot Backend

```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Hot reload |
| `npm run build` | Compile TS |
| `npm run start` | Run compiled |

## Optional

**Browser** (`BROWSER_ENABLED=true`): `npx playwright install chromium` + `npx playwright install-deps chromium`

**WhatsApp**: Set `WHATSAPP_ENABLED=true`, `WHATSAPP_ALLOWED_FROM` or `WHATSAPP_SELF_ONLY=true`. QR on first start.

**Vision** (photo analysis): Uses Gemini or `OLLAMA_VISION_MODEL=llava` with Ollama.
