# maikBot Architecture

This document describes the target runtime architecture for maikBot, why it is designed this way, and how all interfaces are connected.

## Goals

- Keep AI inference local (privacy and control).
- Avoid inbound internet exposure for the bot runtime.
- Keep MCP skill backends internal and authenticated.
- Use clear interface boundaries to simplify hardening and troubleshooting.

## High-Level Design

maikBot runs as a local backend service and connects to Telegram using long polling.  
Ollama runs in a Proxmox LXC container on the local network.  
Skill actions are reached through a Home Assistant MCP Server endpoint (`/api/mcp`).

## Deployment Diagram (Mermaid)

See `docs/diagrams/deployment.mmd`.

## Message Flow (Mermaid Sequence)

See `docs/diagrams/message-flow.mmd`.

If you want static assets for wikis or docs sites, render them with Mermaid CLI:

```bash
mmdc -i docs/diagrams/deployment.mmd -o docs/diagrams/deployment.svg
mmdc -i docs/diagrams/message-flow.mmd -o docs/diagrams/message-flow.svg
```

## Why This Design Makes Sense

1. No public inbound ports for bot traffic
- Long polling means maikBot only opens outbound connections to Telegram.
- You do not need a public webhook endpoint, reverse proxy, or router port forwarding.

2. Better isolation for AI runtime
- Ollama is local in LXC, not exposed to WAN.
- LXC isolation limits blast radius versus running all services in one host context.

3. Controlled tool access
- maikBot talks to Home Assistant tools through MCP, not directly from arbitrary prompts.
- Home Assistant MCP Server provides a policy/control point (auth, tool restrictions).

4. Operational simplicity
- Clear service boundaries make incidents easier to diagnose:
  Telegram connectivity, Ollama inference, MCP skill actioning.

## Interface Contract Overview

| From | To | Protocol | Endpoint | Auth | Purpose |
|---|---|---|---|---|---|
| maikBot | Telegram | HTTPS | `getUpdates`, `sendMessage` | Bot token | Receive/send chat messages |
| maikBot | Ollama | HTTP/HTTPS (internal) | `POST /api/chat` | Network-level controls | LLM inference |
| maikBot | Home Assistant MCP Server | HTTP/HTTPS (internal) | `POST /api/mcp` | Home Assistant long-lived token | MCP tools/list + tools/call |
| Home Assistant MCP Server | Home Assistant entities/services | Internal integration | Native HA service calls | Scoped MCP exposure | Execute allowed HA actions/queries |

## Recommended Network Policy

Default policy: deny all, allow only explicit flows.

- Allow `maikBot -> Telegram` (outbound TCP 443).
- Allow `maikBot -> Ollama` (internal port 11434 only).
- Allow `maikBot -> Home Assistant` (internal port 8123 for `/api/mcp` only).
- Deny WAN access to Ollama and Home Assistant admin endpoints where possible.

## Container/Host Hardening Notes

- Run Ollama in an unprivileged LXC where possible.
- Keep system and container packages updated.
- Store secrets in `.env` / secret manager, never in git.
- Scope Home Assistant token/API key to minimal permissions.
- Keep Telegram allowlist active via `ALLOWED_TELEGRAM_USER_IDS`.

## Current Repository Mapping

- Bot entrypoint: `backend/src/index.ts`
- Telegram long polling: `backend/src/services/telegram-bot.service.ts`
- Assistant routing (currently `/ha` path): `backend/src/core/assistant.ts`
- Ollama integration: `backend/src/services/ollama.service.ts`
- MCP integration (currently HA-focused naming): `backend/src/services/home-assistant-mcp.service.ts`
- Configuration schema: `backend/src/config.ts`
