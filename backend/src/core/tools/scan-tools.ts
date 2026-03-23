import {
  isScanEnabled,
  startOrAddPage,
  finishSession,
  cancelSession,
  getSession,
} from '../../services/scan.service.js';
import type { ToolDefinition } from '../../services/llm.types.js';
import type { SessionId } from '../channel-types.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

export function getScanTools(sessionId: SessionId): {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}[] {
  const targetKey = sessionId;

  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'scan_add_page',
          description:
            'Trigger a scan at the configured printer/scanner. Adds one page to the current scan session. Use when the user asks to scan (e.g. "scanne am Drucker", "scan document"). Document must be on the scanner glass.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async () => {
        if (!isScanEnabled()) {
          return {
            ok: false,
            output: 'Scan nicht konfiguriert. Setze SCAN_BACKEND und SCAN_HP_PRINTER_IP oder SCAN_SANE_DEVICE.',
          };
        }
        const result = await startOrAddPage(targetKey);
        return {
          ok: result.ok,
          output: result.ok ? (result.message ?? '') : (result.error ?? result.message ?? 'Scan fehlgeschlagen'),
        };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'scan_status',
          description: 'Check if there is an active scan session and how many pages. Use when the user asks "how many pages" or "scan status".',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async () => {
        const session = getSession(targetKey);
        if (!session || session.pages.length === 0) {
          return { ok: true, output: 'Keine aktive Scan-Session.' };
        }
        return {
          ok: true,
          output: `${session.pages.length} Seite(n) gescannt. Sage "fertig" oder nutze /scan done für das PDF.`,
        };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'scan_cancel',
          description: 'Cancel the current scan session. Use when the user wants to abort scanning.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async () => {
        const result = cancelSession(targetKey);
        return {
          ok: result.ok,
          output: result.message ?? 'Keine Scan-Session.',
        };
      },
    },
  ];
}
