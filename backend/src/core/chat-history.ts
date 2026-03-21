import { logger } from '../logger.js';
import { config } from '../config.js';
import type { LlmMessage } from '../services/llm.types.js';
import type { SessionId } from './channel-types.js';

interface ChatSession {
  messages: LlmMessage[];
  lastActivity: number;
}

const ESTIMATED_CHARS_PER_TOKEN = 4;

export class ChatHistory {
  private sessions = new Map<SessionId, ChatSession>();

  constructor(
    private maxMessages: number = 50,
    private maxAgeMs: number = config.chatMaxAgeMs,
    private maxContextTokens: number = 100_000
  ) {}

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
  }

  clear(sessionId: SessionId): boolean {
    const existed = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);
    if (existed) {
      logger.info({ sessionId }, 'Chat history cleared');
    }
    return existed;
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
