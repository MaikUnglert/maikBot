# maikBot Backend

The `maikBot` Backend serves as a secure and extensible foundation for an AI assistant accessible via **Telegram** and **WhatsApp**, enabling intelligent interactions through various Large Language Models (LLMs) and a rich set of tools. It integrates with external services and provides robust task scheduling capabilities, monitoring, and modular control.

## Setup

```bash
npm install
cp .env.example .env   # fill in values
npm run dev
```

## Architecture Overview

The backend is structured into several key components:

-   **Core**: Contains the fundamental logic for the assistant, including chat history management, tool definitions, and the tool registry.
-   **Services**: Manages integrations with external systems and core functionalities, such as LLM providers (Gemini, Ollama), the Telegram bot interface, system heartbeat, NVIDIA device monitoring, and the Modular Control Plane (MCP) host.
-   **Agent**: Hosts the task scheduling mechanism, implemented as a Python component.

## Key Features

-   **LLM Integration**: Seamlessly switch between Gemini and Ollama for intelligent conversational AI.
-   **Telegram & WhatsApp**: Chat interfaces via Telegram and WhatsApp (Baileys). See [docs/WHATSAPP.md](../docs/WHATSAPP.md) for WhatsApp setup.
-   **Extensible Tool Ecosystem**: A growing collection of tools for various tasks, including agent configuration, Gemini CLI interactions, memory management, scheduling, shell command execution, and **browser automation** (Playwright-based web browsing).
-   **Task Scheduling**: A Python-based task scheduler enables automated execution of predefined tasks.
-   **NVIDIA Monitoring**: Provides capabilities to monitor NVIDIA device status.
-   **Modular Control Plane (MCP)**: Facilitates interaction with external Home Assistant instances for smart home control.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm run start` | Run compiled JS |
| `npm run check` | Type-check without emitting |
| `npm run test:shell` | Shell tool unit tests |
| `npm run test:registry` | Tool registry tests |
| `npm run test:ollama:reachability` | Ollama connectivity test |
| `npm run test:ollama:chat` | Ollama chat test |
| `npm run test:ha:reachability` | Home Assistant connectivity test |
| `npm run test:ha:mcp-tools` | MCP tools list test |

## Configuration

All configuration is managed via environment variables. Refer to `.env.example` for a comprehensive list and descriptions.

Key variables include:
-   `LLM_PROVIDER` — Specifies the LLM to use (`gemini` or `ollama`).
-   `GEMINI_API_KEY` — API key for Google AI Studio.
-   `GEMINI_MODEL` — The specific Gemini model to use (e.g., `gemini-2.5-flash`).
-   `OLLAMA_BASE_URL` / `OLLAMA_MODEL` — Configuration for local Ollama instances.
-   `TELEGRAM_BOT_TOKEN` / `ALLOWED_TELEGRAM_USER_IDS` — Credentials and authorized user IDs for the Telegram bot.
-   `WHATSAPP_ENABLED` / `WHATSAPP_ALLOWED_FROM` — Optional WhatsApp channel (see [docs/WHATSAPP.md](../docs/WHATSAPP.md)).
-   `MCP_SERVERS_JSON` — JSON configuration for Modular Control Plane servers, used for interacting with external systems like Home Assistant.
-   `NVIDIA_SMI_PATH` - Path to the nvidia-smi executable for NVIDIA GPU monitoring.
-   `BROWSER_ENABLED` — Enable Playwright-based browser automation (`true`/`false`). Default: `false`.
-   `BROWSER_HEADLESS` — Run browser headless (`true`) or with visible window (`false`). Default: `true`.
-   `BROWSER_TIMEOUT_MS` — Page operation timeout in milliseconds. Default: `30000`.

### Browser tool

When `BROWSER_ENABLED=true`, the agent gets tools to browse the web: `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_screenshot_analyze`, `browser_click`, `browser_type`, `browser_close`. This uses an isolated headless Chromium instance (similar to [OpenClaw's browser](https://docs.openclaw.ai/tools/browser)). On first use, install the browser binary:

```bash
npx playwright install chromium
```

For security, navigation to localhost and private IPs is blocked; only public URLs are allowed.

### Vision (image analysis)

Images are analyzed via Gemini or Ollama LLaVA:

- **Telegram photos**: When you send a photo (with or without caption), the bot downloads it, runs vision analysis, and injects the description into the conversation. The agent can then answer questions about the image.
- **`vision_analyze_image` tool**: Analyze any image by file path. Use when the agent has a path (e.g. from `browser_screenshot` or user-provided).
- **`browser_screenshot_analyze`**: For browser pages, takes a screenshot and analyzes it with vision AI.

Requires `GEMINI_API_KEY` (preferred) or `OLLAMA_BASE_URL` with a vision model. For Ollama, set `OLLAMA_VISION_MODEL=llava` (or `llava:13b`).
