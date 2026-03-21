# Design: Gemini CLI Integration & Persistent Context

This document describes a proposed architecture for letting maikBot delegate larger coding tasks to Gemini CLI (YOLO mode) and maintaining context across long-running workflows.

## Goals

1. **Agent self-editing / delegation**: maikBot can hand off coding tasks to Gemini CLI when they exceed its scope (e.g. multi-file refactors, complex features).
2. **Telegram UX**: User sees "I've started Gemini CLI on this. I'll notify you when it's done." and later gets a review + summary.
3. **Result review**: When Gemini CLI finishes, maikBot reviews the output, optionally gives feedback, and notifies the user.
4. **Context strategy**: No loss of context after 1 hour for active/long-running tasks.

---

## Current State

- **Chat history**: In-memory only, max 50 messages, 100k tokens, **expires after 1h** (`maxAgeMs`).
- **Gemini CLI**: Headless mode with `gemini -p "task" --yolo --output-format json`; auto-approves edits/commands; returns structured JSON.
- **Shell tool**: `shell_exec` exists but blocks; not suitable for long-running Gemini CLI jobs.

---

## Architecture Overview

```
User: "Refactor the auth module"
        │
        ▼
   maikBot agent
        │
        ├─► Decides: "This is a larger coding task"
        │
        ├─► Calls tool: gemini_cli_delegate(task, workspace, chatId)
        │
        ├─► Spawns: gemini --yolo -p "task" --output-format json ...
        │   (background process)
        │
        └─► Replies: "I've started Gemini CLI on this. I'll notify you when done."
                │
                ▼
        [Job stored: { chatId, task, status: running, contextSnapshot }]
                │
                ▼
        [Heartbeat / job monitor checks periodically]
                │
                ▼
        Gemini CLI exits
                │
                ▼
        Load contextSnapshot + CLI output
        maikBot reviews (LLM call with full context)
                │
                ▼
        Telegram: "Gemini CLI finished. Here's my review: ..."
```

---

## Components

### 1. Gemini CLI Integration Service

- **`gemini-cli.service.ts`**
  - Spawns `gemini -p "..." --yolo --output-format json` via `child_process.spawn`.
  - Optional: `--include-directories` for workspace scope.
  - Writes stdout/stderr to job log; parses JSON result on exit.
  - Job state: `pending` → `running` → `completed` | `failed`.

### 2. Job Store (Persistent)

- **`data/jobs/{jobId}.json`**
  - `jobId`, `chatId`, `task`, `status`, `createdAt`, `completedAt`
  - `contextSnapshot`: compact representation of the conversation (user request, last N messages or summary) for the review step.
  - `result`: CLI output (response, stats, error) when done.
  - Survives restarts; heartbeat picks up orphaned `running` jobs (e.g. mark as `failed` if process gone).

### 3. Tool: `gemini_cli_delegate`

- **Parameters**: `task` (string), `workspace` (optional path), `include_dirs` (optional).
- **Behavior**:
  - Validates `workspace` is within allowed paths (security).
  - Creates job, spawns Gemini CLI, returns job ID and status message.
  - Agent reply: "I've handed this off to Gemini CLI. I'll review the result and notify you when it's done."

### 4. Heartbeat Extension

- **Job monitor** (runs with existing heartbeat or separate interval):
  - Poll running jobs: check if process still alive.
  - On process exit: load job, parse result, call **review pipeline**.

### 5. Review Pipeline

- **Input**: Job with `contextSnapshot` + CLI `result`.
- **Flow**:
  1. Restore context: inject `contextSnapshot` into a temporary session (or append to chat history for that chat).
  2. LLM call: "Review this Gemini CLI result for the user's request: [task]. Output: [result]. Provide a concise summary and any feedback. If something looks wrong, say so."
  3. Send review to user via Telegram.
  4. Mark job `completed`; optionally append review to chat history for continuity.

### 6. Context Strategy

**Problem**: Chat history expires after 1h; Gemini CLI jobs can run 5–30+ minutes.

**Options**:

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A. Persist chat history to disk | Store sessions in `data/chat/{chatId}.json`; load on demand | Full continuity, survives restarts | More disk I/O; need migration |
| B. Extend maxAgeMs for jobs | If chat has pending job, set `maxAgeMs = 24h` for that chat | Simple | In-memory only; lost on restart |
| C. Context snapshot per job | Save compact context when delegating; restore only for review | Isolated, no change to main history | Review has limited prior context |
| D. Hybrid | Persist history for chats with active jobs; otherwise keep current behavior | Balance | More logic |

**Recommendation**: Start with **C** (context snapshot) for the review step. Optionally add **A** (persistent chat history) as a separate improvement so the user can continue the conversation naturally after the review.

**Context snapshot contents**:
- User's original request (full text).
- Last 5–10 messages (or token-bounded summary) from the conversation.
- Timestamp, chatId, jobId.

### 7. Agent Config Editing

- **Tool: `agent_config_get` / `agent_config_set`** (or similar)
  - Read/write a subset of config (e.g. `LLM_PROVIDER`, `GEMINI_MODEL`) from a safe config file.
  - Config changes apply after restart or via a hot-reload mechanism.
  - **Security**: Restrict to non-sensitive keys; never expose tokens.
  - Can be Phase 2 if desired.

---

## Telegram UX

1. **On delegate**:
   - "I've started Gemini CLI on this task. It may take a few minutes. I'll notify you when it's done."

2. **Optional progress** (if we capture streaming output):
   - "Gemini CLI: editing 3 files..." (could be throttled).

3. **On completion**:
   - "Gemini CLI finished. **Summary**: [concise summary]. **Changes**: [files modified, lines added/removed]. **My review**: [agent's assessment]. [Optional: Anything you'd like me to change?]"

4. **On failure**:
   - "Gemini CLI failed: [error]. Should I retry or try a different approach?"

---

## Security Considerations

- **Workspace scope**: Only allow paths under a configurable root (e.g. `GEMINI_CLI_WORKSPACE_ROOT`).
- **YOLO mode**: Executes commands and edits without confirmation. Use only in controlled environments (git-tracked repos, sandbox).
- **Config editing**: Whitelist of safe keys; no secrets.
- **Job isolation**: Each job runs in its own process; no shared mutable state.

---

## Implementation Phases

| Phase | Scope | Effort |
|-------|-------|--------|
| 1 | Job store, `gemini_cli_delegate` tool, spawn + monitor, review pipeline, context snapshot | Medium |
| 2 | Persistent chat history (optional, for full continuity) | Small |
| 3 | Agent config get/set (optional) | Small |
| 4 | Progress updates in Telegram (streaming/throttled) | Medium |

---

## Open Questions

1. **Gemini CLI installation**: Assume `gemini` is on `PATH` and configured (auth, etc.)?
2. **Workspace default**: Use `process.cwd()` or a dedicated `GEMINI_CLI_WORKSPACE_ROOT`?
3. **Feedback loop**: Should maikBot be able to re-invoke Gemini CLI with "fix X" based on its review, or is one-shot enough for v1?
