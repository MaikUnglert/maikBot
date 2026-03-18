import { logger } from '../logger.js';
import type { LlmMessage } from '../services/llm.types.js';

interface ChatSession {
  messages: LlmMessage[];
  lastActivity: number;
}

const ESTIMATED_CHARS_PER_TOKEN = 4;

export class ChatHistory {
  private sessions = new Map<number, ChatSession>();

  constructor(
    private maxMessages: number = 50,
    private maxAgeMs: number = 60 * 60 * 1000, // 1 hour
    private maxContextTokens: number = 100_000
  ) {}

  /**
   * Returns the stored conversation history for a chat.
   * Automatically prunes expired sessions.
   */
  getHistory(chatId: number): LlmMessage[] {
    this.pruneExpired();
    const session = this.sessions.get(chatId);
    return session ? [...session.messages] : [];
  }

  /**
   * Appends messages to a chat session. Trims oldest messages
   * if the session exceeds maxMessages or estimated token budget.
   */
  append(chatId: number, messages: LlmMessage[]): void {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = { messages: [], lastActivity: Date.now() };
      this.sessions.set(chatId, session);
    }

    session.messages.push(...messages);
    session.lastActivity = Date.now();

    this.trimSession(session);
  }

  clear(chatId: number): boolean {
    const existed = this.sessions.has(chatId);
    this.sessions.delete(chatId);
    if (existed) {
      logger.info({ chatId }, 'Chat history cleared');
    }
    return existed;
  }

  getStats(chatId: number): { messageCount: number; estimatedTokens: number } {
    const session = this.sessions.get(chatId);
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
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity > this.maxAgeMs) {
        this.sessions.delete(chatId);
        logger.debug({ chatId }, 'Chat session expired');
      }
    }
  }
}

export const chatHistory = new ChatHistory();
