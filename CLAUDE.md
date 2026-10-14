# CLAUDE.md — MaikBot Agent Engineering Protocol

This file defines the working protocol for Claude/Gemini agents in this repository.
Scope: entire repository.

## 1) Project Snapshot

MaikBot is a TypeScript/Node.js personal AI assistant running on a home server, optimized for:

- **Home automation** via Home Assistant MCP integration
- **Multi-channel messaging** (Telegram, WhatsApp)
- **Self-improvement** via Gemini CLI delegation
- **Task scheduling** with persistent reminders and recurring tasks
- **Document processing** via Paperless-ngx integration
- **Local-first** operation with Ollama, Gemini, or NVIDIA as LLM backends

Core architecture is modular and tool-based. Extension work should add new tools or services.

## 2) Repository Map

```
backend/
├── src/
│   ├── index.ts              # Entrypoint, service initialization
│   ├── config.ts             # Environment schema (Zod), all config keys
│   ├── logger.ts             # Pino logger setup
│   ├── core/
│   │   ├── assistant.ts      # Main orchestration, system prompt, tool loop
│   │   ├── chat-history.ts   # Session/conversation management
│   │   ├── tool-registry.ts  # Tool loading and execution
│   │   ├── tool-categories.ts # HA tool category definitions
│   │   ├── channel-types.ts  # Channel abstraction (Telegram/WhatsApp)
│   │   └── tools/
│   │       ├── shell.ts          # shell_exec, async jobs
│   │       ├── schedule-tools.ts # schedule_reminder, daily, weekly
│   │       ├── memory.ts         # Memory file operations
│   │       ├── browser-tools.ts  # Playwright browser automation
│   │       ├── vision-tools.ts   # Image analysis
│   │       ├── gemini-cli-tools.ts # Gemini CLI delegation
│   │       ├── scan-tools.ts     # Printer scanning
│   │       └── agent-config-tools.ts # Runtime LLM switching
│   └── services/
│       ├── llm.service.ts        # LLM abstraction layer
│       ├── ollama.service.ts     # Ollama provider
│       ├── gemini.service.ts     # Gemini provider
│       ├── nvidia.service.ts     # NVIDIA NIM provider
│       ├── telegram-bot.service.ts # Telegram channel
│       ├── whatsapp-bot.service.ts # WhatsApp (Baileys)
│       ├── mcp-host.service.ts   # MCP client for Home Assistant
│       ├── task-scheduler.service.ts # Persistent scheduled tasks
│       ├── gemini-cli.service.ts # External Gemini CLI orchestration
│       └── heartbeat.service.ts  # Periodic wake for scheduled work
├── data/                     # Runtime data (memory, jobs, sessions)
└── package.json
```

## 3) Engineering Principles

### 3.1 Security First

- No WAN exposure for Ollama, MCP, or Home Assistant.
- Never commit secrets (.env, API keys, tokens).
- Validate all external inputs.
- Keep shell_exec sandboxed to safe commands.

### 3.2 KISS (Keep It Simple)

- Prefer straightforward control flow.
- Keep error paths obvious and localized.
- One concern per function/module.

### 3.3 YAGNI (You Aren't Gonna Need It)

- Do not add config keys or features without a concrete use case.
- No speculative "future-proof" abstractions.
- Keep unsupported paths explicit (throw error, don't fake support).

### 3.4 DRY + Rule of Three

- Duplicate small, local logic when it preserves clarity.
- Extract shared utilities only after repeated, stable patterns.

### 3.5 Fail Fast

- Prefer explicit errors for unsupported states.
- Never silently broaden permissions.
- Log errors with context for debugging.

## 4) Self-Improvement Protocol

MaikBot can modify its own code. When improving:

1. **Understand first**: Read relevant files before editing.
2. **Use gemini_cli_delegate** for multi-file changes.
3. **Branch workflow**:
   - Create feature branch: `feature/<description>`
   - Make changes, commit with clear message
   - Push to origin
   - Open PR via `gh pr create`
4. **Never commit to main directly**.
5. **Simple edits** (prompt tweaks, memory): Use `shell_exec` + ask user to `/reload`.
6. **After PR merge**: User runs `/update` to pull and restart.

Key files for self-modification:
- `backend/src/core/assistant.ts` — System prompt in `buildSystemPrompt()`
- `backend/src/core/tools/*.ts` — Add new tools here
- `backend/src/config.ts` — Add new config keys here

## 5) Tool Development Guide

When adding a new tool:

1. Create file in `backend/src/core/tools/`.
2. Export function returning `{ definition, execute }[]`.
3. Register in `tool-registry.ts`.
4. Follow existing patterns (see `schedule-tools.ts` as reference).

Tool contract:
```typescript
{
  definition: ToolDefinition;  // OpenAI function schema
  execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
}
```

## 6) Agent Workflow

1. **Read before write** — Inspect existing code before editing.
2. **Define scope** — One concern per PR.
3. **Implement minimal patch** — Apply KISS/YAGNI.
4. **Test locally** — Run `npm run check` (TypeScript).
5. **Document impact** — Update README if CLI/config changes.

## 7) Validation

```bash
cd backend
npm run check    # TypeScript type-check
npm run build    # Full build
npm test         # Run tests (if available)
```

## 8) PR Discipline

- Use feature branches: `feature/`, `fix/`, `chore/`.
- Conventional commit titles: `feat:`, `fix:`, `chore:`, `docs:`.
- Keep PRs small and focused.
- Include what changed, why, and any risks.

## 9) Risk Tiers

- **Low**: docs, comments, logging changes
- **Medium**: new tools, config keys, minor logic changes
- **High**: `assistant.ts` (system prompt), `config.ts`, services, security-related

For high-risk changes, include rollback strategy.

## 10) Anti-Patterns (Do Not)

- Do not add heavy dependencies for minor convenience.
- Do not silently weaken security.
- Do not mix formatting changes with functional changes.
- Do not modify unrelated modules "while here".
- Do not commit secrets or personal data.
- Do not bypass TypeScript errors with `any` casts.

## 11) Memory and State

- **Memory file**: `data/memory/memory.md` — Persistent facts, preferences.
- **Chat sessions**: `data/chat-sessions/` — Per-channel conversation history.
- **Scheduled tasks**: `data/scheduler/` — Persistent reminders and recurring jobs.
- **Gemini jobs**: `data/jobs/` — Async Gemini CLI job state.

## 12) Config Reference

All config via environment variables (see `config.ts`):

| Key | Description |
|-----|-------------|
| `LLM_PROVIDER` | `ollama`, `gemini`, or `nvidia` |
| `OLLAMA_MODEL` | Ollama model name |
| `GEMINI_MODEL` | Gemini model name |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `HA_MCP_BASE_URL` | Home Assistant MCP URL |
| `SCHEDULER_DEFAULT_TIMEZONE` | Timezone for scheduled tasks |

See `backend/src/config.ts` for full schema.

## 13) Handoff Template

When handing off work:

1. What changed
2. What did not change
3. Validation run and results
4. Remaining risks / unknowns
5. Next recommended action
