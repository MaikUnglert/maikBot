# maikBot Architecture

## Goals

- Support both cloud (Gemini) and local (Ollama) LLM inference.
- Avoid inbound internet exposure for the bot runtime.
- Keep MCP skill backends internal and authenticated.
- Maintain conversation context across messages.

## High-Level Design

maikBot runs as a local backend service and connects to Telegram using long polling.
LLM inference is handled by either Google Gemini (cloud) or Ollama (local LXC), switchable at runtime via `/model`.
Tool actions are reached through MCP (Home Assistant) and built-in tools (shell_exec).

## Interface Contract Overview

| From | To | Protocol | Auth | Purpose |
|---|---|---|---|---|
| maikBot | Telegram | HTTPS (outbound) | Bot token | Chat messages |
| maikBot | Gemini API | HTTPS (outbound) | API key | LLM inference (cloud) |
| maikBot | Ollama | HTTP (internal) | Network-level | LLM inference (local) |
| maikBot | HA MCP Server | HTTP (internal) | HA long-lived token | Smart home tools |

## Components

### LLM Service (`llm.service.ts`)
Router that delegates to the active provider. Supports runtime switching.
Both providers implement the `LlmProvider` interface (`llm.types.ts`).

### Tool Registry (`tool-registry.ts`)
Loads MCP tools (policy-filtered) and built-in tools into a unified dispatch map.
Tool definitions are provider-agnostic (`ToolDefinition` format).

### Chat History (`chat-history.ts`)
In-memory per-chat conversation store. Includes tool calls and results.
Auto-trims by message count (50), token estimate (100k), and session age (1h).

### Assistant (`assistant.ts`)
Orchestrates the full message flow:
1. Load history + tools
2. Send to LLM with tool definitions
3. Execute tool calls, feed results back (multi-turn loop)
4. Save turn to history
5. Return final response

## Network Policy

Default: deny all, allow only:
- `maikBot → Telegram` (outbound TCP 443)
- `maikBot → Gemini API` (outbound TCP 443)
- `maikBot → Ollama` (internal port 11434)
- `maikBot → Home Assistant` (internal port 8123, `/api/mcp` only)
