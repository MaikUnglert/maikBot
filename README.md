# maikBot

Local AI assistant with a security-first design:
- Telegram as chat channel via long polling (no open inbound port)
- Ollama in the local Proxmox/LXC network
- MCP as an optional multi-skill tool layer (currently Home Assistant, later e.g. Paperless)

## Target Architecture

Detailed architecture, rationale, interfaces, and diagrams:
- `docs/ARCHITECTURE.md`
- `docs/diagrams/deployment.mmd`
- `docs/diagrams/message-flow.mmd`

### Deployment Diagram

```mermaid
flowchart LR
    User[User on Telegram App]
    TG[Telegram Cloud API]

    subgraph LAN[Home LAN]
      subgraph Proxmox[Proxmox Host]
        subgraph VM[VM or Host Process]
          MB["maikBot Backend<br/>Node.js + TypeScript"]
        end
        subgraph LXC[Unprivileged LXC]
          OL["Ollama API<br/>:11434"]
        end
      end

      MCP["Home Assistant MCP Server<br/>(auth protected)"]
      subgraph Skills[Skill Backends]
        HA[Home Assistant]
        PL["Paperless - future"]
      end
    end

    User --> TG
    MB -->|Telegram API long polling| TG
    MB -->|Internal HTTP| OL
    MB -->|Internal HTTP with auth| MCP
    MCP -->|Home Assistant tools| Skills

```

### Message Flow

```mermaid
sequenceDiagram
    autonumber
    participant U as Telegram User
    participant TG as Telegram Cloud
    participant B as maikBot Backend
    participant O as Ollama (LXC)
    participant M as Home Assistant MCP Server
    participant S as Skill Backend (e.g. Home Assistant, Paperless)

    U->>TG: Send message
    B->>TG: getUpdates (long polling)
    TG-->>B: Update with message

    alt Normal chat message
        B->>O: POST /api/chat
        O-->>B: Model response
    else Message starts with skill command (currently /ha)
        B->>M: POST /api/mcp tools/call (auth)
        M->>S: Execute selected skill action/query
        S-->>M: Tool result
        M-->>B: Tool output
    end

    B->>TG: sendMessage
    TG-->>U: Bot response
```

## Security Principles

1. Do not expose Ollama directly to the internet.
2. Use Telegram long polling instead of Telegram webhooks.
3. Enable a Telegram user allowlist (`ALLOWED_TELEGRAM_USER_IDS`).
4. Use MCP only internally and only with API key/TLS.
5. Keep Proxmox/LXC firewalls on default-deny and allow only required flows.

## Repository Status

- `backend/`: fresh backend implementation from scratch (TypeScript)
- `backend/src/services/telegram-bot.service.ts`: long-polling bot
- `backend/src/services/ollama.service.ts`: Ollama client
- `backend/src/services/home-assistant-mcp.service.ts`: MCP connector (currently HA-focused naming)
- `backend/src/core/assistant.ts`: routes messages (currently `/ha ...` -> MCP)

## Quick Start

See `QUICKSTART.md`.
