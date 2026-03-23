import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../logger.js';
import {
  parseSessionId,
  type SessionId,
} from '../core/channel-types.js';
import {
  formatMarkdownForTelegram,
  formatMarkdownForWhatsApp,
} from './markdown-formatter.js';

export interface ChannelSenderDeps {
  telegramBot: TelegramBot | null;
  /** Send text to WhatsApp JID. Returns true on success. */
  sendWhatsApp?: (jid: string, text: string) => Promise<boolean>;
}

let deps: ChannelSenderDeps | null = null;

export function setChannelSenderDeps(d: ChannelSenderDeps): void {
  deps = d;
}

/**
 * Send a text message to a session, routing to the correct channel.
 * Handles Telegram HTML formatting for tg: sessions.
 */
export async function sendToSession(
  sessionId: SessionId,
  text: string
): Promise<boolean> {
  const d = deps;
  if (!d) {
    logger.error({ sessionId }, 'Channel sender not initialized');
    return false;
  }

  const parsed = parseSessionId(sessionId);
  if (!parsed) {
    logger.error({ sessionId }, 'Invalid session ID format');
    return false;
  }

  if (parsed.channel === 'telegram') {
    if (!d.telegramBot) {
      logger.error({ sessionId }, 'Telegram bot not available');
      return false;
    }
    try {
      const chatId = Number.parseInt(parsed.targetId, 10);
      const formatted = formatMarkdownForTelegram(text).slice(0, 4096);
      await d.telegramBot.sendMessage(chatId, formatted, { parse_mode: 'HTML' });
      return true;
    } catch (error) {
      logger.error({ err: error, sessionId }, 'Channel sender: failed to send via Telegram');
      try {
        await d.telegramBot.sendMessage(
          Number.parseInt(parsed.targetId, 10),
          text.slice(0, 4096)
        );
        return true;
      } catch (fallbackError) {
        logger.error(
          { err: fallbackError, sessionId },
          'Channel sender: Telegram fallback also failed'
        );
        return false;
      }
    }
  }

  if (parsed.channel === 'whatsapp') {
    if (!d.sendWhatsApp) {
      logger.error({ sessionId }, 'WhatsApp not available');
      return false;
    }
    const formatted = formatMarkdownForWhatsApp(text).slice(0, 4000);
    return d.sendWhatsApp(parsed.targetId, formatted);
  }

  return false;
}
