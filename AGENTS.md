# AGENTS.md

## Project Priorities

- Security first. Prefer designs that reduce attack surface, even if they are less convenient.
- Keep sensitive services private: no direct WAN exposure for Ollama, MCP, or Home Assistant.
- Use least privilege everywhere: minimal tokens, minimal network access, minimal permissions.
- Default-deny network policy; allow only required traffic between components.
- Never commit secrets (tokens, API keys, passwords, private endpoints).

## Language Rules

- All documentation must be in English.
- All code comments must be in English.
- All user-facing bot/system messages in this project must be in English.

## Implementation Guardrails

- Prefer Telegram long polling over inbound webhooks unless explicitly required.
- Treat Home Assistant access as high-risk: route through authenticated MCP tooling.
- Keep changes small, auditable, and easy to review.

## Git Workflow

- **Always** use a feature branch for every change, no matter how small. Never commit directly to `main`.
- Merge to `main` via fast-forward when done, then delete the branch.
- Write concise commit messages that explain *why*, not *what*; use imperative mood.
- Never force-push to `main`. Never commit `.env` or secrets.
