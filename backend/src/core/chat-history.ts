import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { config } from '../config.js';
import type { LlmMessage } from '../services/llm.types.js';
import type { SessionId } from './channel-types.js';

interface ChatSession {
  messages: LlmMessage[];
  lastActivity: number;
}

/** Session data for disk (strips image attachments to keep files small). */
interface PersistedSession {
  sessionId: SessionId;
  messages: Array<Omit<LlmMessage, 'imageAttachment'> & { imageAttachment?: never }>;
  lastActivity: number;
}

const ESTIMATED_CHARS_PER_TOKEN = 4;
const SAVE_DEBOUNCE_MS = 2000;

function sanitizeSessionIdForFilename(sessionId: SessionId): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class ChatHistory {
  private sessions = new Map<SessionId, ChatSession>();
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private maxMessages: number = 50,
    private maxAgeMs: number = config.chatMaxAgeMs,
    private maxContextTokens: number = 100_000
  ) {
    this.loadFromDisk();
  }

  private getSessionsDir(): string {
    return config.chatSessionsDir;
  }

  private loadFromDisk(): void {
    try {
      const dir = this.getSessionsDir();
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
          const data = JSON.parse(raw) as PersistedSession;
          if (!data.sessionId) continue;
          const session: ChatSession = {
            messages: data.messages as LlmMessage[],
            lastActivity: data.lastActivity,
          };
          if (Date.now() - data.lastActivity < this.maxAgeMs) {
            this.sessions.set(data.sessionId, session);
          }
        } catch (err) {
          logger.warn({ err, file }, 'Failed to load chat session from disk');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load chat sessions from disk');
    }
  }

  private toPersisted(sessionId: SessionId, session: ChatSession): PersistedSession {
    const messages = session.messages.map((m) => {
      const { imageAttachment: _, ...rest } = m;
      return rest;
    });
    return { sessionId, messages, lastActivity: session.lastActivity };
  }

  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    try {
      const dir = this.getSessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const keepFiles = new Set<string>();
      for (const [sessionId, session] of this.sessions) {
        const safeName = sanitizeSessionIdForFilename(sessionId) || 'default';
        keepFiles.add(`${safeName}.json`);
        const filePath = path.join(dir, `${safeName}.json`);
        fs.writeFileSync(
          filePath,
          JSON.stringify(this.toPersisted(sessionId, session), null, 2),
          'utf-8'
        );
      }
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.json') && !keepFiles.has(file)) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to save chat sessions to disk');
    }
  }

  /** Flush all sessions to disk immediately. Call before process exit. */
  persistAll(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveToDisk();
  }

  /**
   * Returns the stored conversation history for a chat.
   * Automatically prunes expired sessions.
   */
  getHistory(sessionId: SessionId): LlmMessage[] {
    this.pruneExpired();
    const session = this.sessions.get(sessionId);
    return session ? [...session.messages] : [];
  }

  /**
   * Appends messages to a chat session. Trims oldest messages
   * if the session exceeds maxMessages or estimated token budget.
   */
  append(sessionId: SessionId, messages: LlmMessage[]): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { messages: [], lastActivity: Date.now() };
      this.sessions.set(sessionId, session);
    }

    session.messages.push(...messages);
    session.lastActivity = Date.now();

    this.trimSession(session);
    this.scheduleSave();
  }

  clear(sessionId: SessionId): boolean {
    const existed = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);
    if (existed) {
      logger.info({ sessionId }, 'Chat history cleared');
      this.deleteSessionFile(sessionId);
      this.scheduleSave();
    }
    return existed;
  }

  private deleteSessionFile(sessionId: SessionId): void {
    try {
      const dir = this.getSessionsDir();
      const safeName = sanitizeSessionIdForFilename(sessionId);
      if (!safeName) return;
      const filePath = path.join(dir, `${safeName}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }

  /**
   * Get a compact context snapshot for delegation (e.g. Gemini CLI job).
   * Used when the agent hands off a task so the review step has full context.
   */
  getContextSnapshot(
    sessionId: SessionId,
    userRequest: string,
    maxMessages: number = 10
  ): { userRequest: string; recentMessages: Array<{ role: string; content: string }> } {
    const session = this.sessions.get(sessionId);
    const recentMessages: Array<{ role: string; content: string }> = [];
    if (session) {
      const take = session.messages.slice(-maxMessages);
      for (const msg of take) {
        const content =
          typeof msg.content === 'string'
            ? msg.content.slice(0, 4000)
            : String(msg.content ?? '');
        if (content) {
          recentMessages.push({ role: msg.role, content });
        }
      }
    }
    return { userRequest, recentMessages };
  }

  getStats(sessionId: SessionId): { messageCount: number; estimatedTokens: number } {
    const session = this.sessions.get(sessionId);
    if (!session) return { messageCount: 0, estimatedTokens: 0 };
    return {
      messageCount: session.messages.length,
      estimatedTokens: this.estimateTokens(session.messages),
    };
  }

  private trimSession(session: ChatSession): void {
    // Trim by message count (remove oldest pairs first)
    while (session.messages.length > this.maxMessages) {
      session.messages.shift();
    }

    // Trim by estimated token count
    while (
      session.messages.length > 2 &&
      this.estimateTokens(session.messages) > this.maxContextTokens
    ) {
      session.messages.shift();
    }
  }

  private estimateTokens(messages: LlmMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
      chars += msg.content.length;
      if (msg.toolCalls) {
        chars += JSON.stringify(msg.toolCalls).length;
      }
    }
    return Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivity > this.maxAgeMs) {
        this.sessions.delete(sessionId);
        logger.debug({ sessionId }, 'Chat session expired');
      }
    }
  }
}

export const chatHistory = new ChatHistory();
