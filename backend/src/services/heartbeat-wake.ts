/**
 * Wake callback for the heartbeat. Used when work is scheduled (tasks, Gemini CLI jobs)
 * so the heartbeat can start/resume instead of sleeping indefinitely.
 * No dependencies to avoid circular imports.
 */
let wakeCallback: (() => void) | null = null;

export function registerHeartbeatWakeCallback(cb: () => void): void {
  wakeCallback = cb;
}

export function wakeHeartbeat(): void {
  wakeCallback?.();
}
