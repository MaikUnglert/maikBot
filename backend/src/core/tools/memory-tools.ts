import { logger } from '../../logger.js';
import type { ToolDefinition } from '../../services/llm.types.js';
import {
  appendDomainFile,
  readDomainFile,
  strReplaceDomainFile,
} from './memory-store.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

interface MemoryToolEntry {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}

const READ_MAX_OUT = 24_000;

export function getMemoryTools(): MemoryToolEntry[] {
  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'memory_read',
          description:
            'Load persistent notes for a domain (Markdown files on disk). Use domain "home_assistant" before guessing entity_ids from user nicknames like "desk lamp". Do not assume memory content without calling this.',
          parameters: {
            type: 'object',
            required: ['domain'],
            properties: {
              domain: {
                type: 'string',
                description: 'e.g. home_assistant, general',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const domain = typeof args.domain === 'string' ? args.domain.trim() : '';
        try {
          const { exists, content } = await readDomainFile(domain);
          if (!exists) {
            return {
              ok: true,
              output: `(empty) No memory file for domain "${domain}" yet. Use memory_append to add lines, e.g. "- Schreibtisch Lampe -> light.desk_lamp".`,
            };
          }
          const out =
            content.length > READ_MAX_OUT
              ? content.slice(0, READ_MAX_OUT) + '\n...(truncated in tool output; use memory_str_replace for edits)'
              : content;
          return { ok: true, output: out || '(file exists but is empty)' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, domain }, 'memory_read failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'memory_append',
          description:
            'Append text to the end of a domain memory file (Markdown). Creates the file if missing. Prefer one line per fact, e.g. "- user name for X -> entity.id".',
          parameters: {
            type: 'object',
            required: ['domain', 'text'],
            properties: {
              domain: { type: 'string', description: 'e.g. home_assistant' },
              text: {
                type: 'string',
                description: 'Block or lines to append (newline added if missing)',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const domain = typeof args.domain === 'string' ? args.domain.trim() : '';
        const text = typeof args.text === 'string' ? args.text : String(args.text ?? '');
        if (!text.trim()) {
          return { ok: false, output: 'text is empty.' };
        }
        try {
          await appendDomainFile(domain, text);
          return { ok: true, output: `Appended to domain "${domain}".` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, domain }, 'memory_append failed');
          return { ok: false, output: msg };
        }
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'memory_str_replace',
          description:
            'Surgical edit: replace exactly one occurrence of old_string with new_string in the domain file (like coding-agent search/replace). You MUST copy old_string verbatim from memory_read. If match is not unique, include more context lines.',
          parameters: {
            type: 'object',
            required: ['domain', 'old_string', 'new_string'],
            properties: {
              domain: { type: 'string' },
              old_string: {
                type: 'string',
                description: 'Exact substring to replace once',
              },
              new_string: {
                type: 'string',
                description: 'Replacement (can be empty to delete the matched block)',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const domain = typeof args.domain === 'string' ? args.domain.trim() : '';
        const oldString =
          typeof args.old_string === 'string' ? args.old_string : String(args.old_string ?? '');
        const newString =
          typeof args.new_string === 'string' ? args.new_string : String(args.new_string ?? '');
        try {
          await strReplaceDomainFile(domain, oldString, newString);
          return { ok: true, output: `Updated domain "${domain}" (one replacement).` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, domain }, 'memory_str_replace failed');
          return { ok: false, output: msg };
        }
      },
    },
  ];
}
