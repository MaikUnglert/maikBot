import TelegramBot, { Message } from 'node-telegram-bot-api';
import {
  assistant,
  type AssistantProgressCallback,
  type AssistantResponse,
} from '../core/assistant.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sessionIdTelegram } from '../core/channel-types.js';
import { llmService } from './llm.service.js';
import { analyzeImage } from './vision.service.js';

/** Escape for Telegram HTML parse mode, then turn **bold** into <b>…</b>. */
function formatReplyForTelegramHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function formatAssistantReplyForTelegram(response: AssistantResponse): string {
  const traceBlock =
    config.telegramShowAgentTrace && response.trace.length > 0
      ? `\n\n---\nAgent Trace:\n${response.trace.map((line) => `- ${line}`).join('\n')}`
      : '';
  return formatReplyForTelegramHtml(`${response.reply}${traceBlock}`).slice(0, 4096);
}

const PROGRESS_EDIT_THROTTLE_MS = 900;

/** Status overlay only for turns that may hit the LLM (not instant slash commands). */
function shouldShowProgressOverlay(text: string): boolean {
  const t = text.trim();
  if (t === '/clear' || t === '/status') return false;
  if (t.startsWith('/model')) return false;
  return true;
}

function isAllowedUser(userId: number | undefined): boolean {
  if (!userId) {
    return false;
  }

  if (config.allowedTelegramUserIds.size === 0) {
    return true;
  }

  return config.allowedTelegramUserIds.has(userId);
}

async function safeSendMessage(
  bot: TelegramBot,
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to send Telegram message, retrying without formatting');
    // Fallback without parse_mode in case of markdown parsing errors
    try {
      await bot.sendMessage(chatId, text, { reply_to_message_id: options?.reply_to_message_id });
    } catch (fallbackError) {
      logger.error({ err: fallbackError, chatId }, 'Failed to send Telegram message completely');
    }
  }
}

async function downloadTelegramPhoto(bot: TelegramBot, fileId: string): Promise<Buffer | null> {
  try {
    const file = await bot.getFile(fileId);
    if (!file.file_path) {
      logger.warn('Telegram getFile returned no file_path');
      return null;
    }
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logger.warn({ err, fileId }, 'Failed to download Telegram photo');
    return null;
  }
}

function providerSupportsNativeVision(): boolean {
  const provider = llmService.getActiveProviderName();
  return provider === 'nvidia' || provider === 'gemini';
}

function hasFallbackVision(): boolean {
  return !!(config.geminiApiKey || config.ollamaBaseUrl);
}

async function handleMessage(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const sessionId = sessionIdTelegram(chatId);

  if (!isAllowedUser(userId)) {
    logger.warn({ userId }, 'Blocked Telegram user (not in allowlist)');
    await safeSendMessage(bot, chatId, 'Access denied.');
    return;
  }

  let text = msg.text ?? msg.caption ?? '';
  let attachedImage: { base64: string; mimeType: string } | undefined;

  if (msg.photo && msg.photo.length > 0) {
    const largestPhoto = msg.photo[msg.photo.length - 1];
    const buf = await downloadTelegramPhoto(bot, largestPhoto.file_id);
    if (buf) {
      if (providerSupportsNativeVision()) {
        attachedImage = {
          base64: buf.toString('base64'),
          mimeType: 'image/jpeg',
        };
        text = text.trim() || 'What do you see in this image?';
      } else if (hasFallbackVision()) {
        const result = await analyzeImage(buf, 'image/jpeg');
        const analysis = result.ok
          ? result.description
          : `(Vision analysis failed: ${result.description})`;
        const caption = (msg.caption ?? '').trim();
        text =
          `[User sent an image]\n\nVision analysis:\n${analysis}\n\n` +
          (caption ? `User caption: "${caption}"` : 'User did not add a caption. Respond to what you see in the image.');
      }
    }
  }

  if (!text.trim()) {
    if (msg.photo && !providerSupportsNativeVision() && !hasFallbackVision()) {
      await safeSendMessage(
        bot,
        chatId,
        'Image received. To analyze images, use /model gemini or /model nvidia (vision-capable), or configure GEMINI_API_KEY / OLLAMA_BASE_URL with a vision model.',
        { reply_to_message_id: msg.message_id }
      );
    }
    return;
  }

  let response: AssistantResponse | undefined;
  let progressMessageId: number | undefined;
  /** Start negative so the first onProgress edit is never throttled. */
  let lastProgressEditAt = -Number.MAX_VALUE;

  const dismissProgressMessage = async (): Promise<void> => {
    if (progressMessageId === undefined) return;
    const id = progressMessageId;
    progressMessageId = undefined;
    try {
      await bot.deleteMessage(chatId, id);
    } catch {
      /* already removed or missing rights */
    }
  };

  const buildOnProgress = (): AssistantProgressCallback => {
    return async (phase: string) => {
      if (progressMessageId === undefined) return;
      const now = Date.now();
      if (now - lastProgressEditAt < PROGRESS_EDIT_THROTTLE_MS) {
        return;
      }
      lastProgressEditAt = now;
      try {
        await bot.editMessageText(formatReplyForTelegramHtml(`⏳ ${phase}`), {
          chat_id: chatId,
          message_id: progressMessageId,
          parse_mode: 'HTML',
        });
      } catch {
        /* e.g. message not modified */
      }
    };
  };

  try {
    await bot.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => { });
    }, 4500);

    if (shouldShowProgressOverlay(text)) {
      try {
        const sent = await bot.sendMessage(chatId, formatReplyForTelegramHtml('⏳ Working…'), {
          reply_to_message_id: msg.message_id,
          parse_mode: 'HTML',
        });
        progressMessageId = sent.message_id;
      } catch (err) {
        logger.warn({ err }, 'Could not send progress status message');
      }
    }

    try {
      response = await assistant.handleTextWithTrace(sessionId, text, {
        onProgress: buildOnProgress(),
        ...(attachedImage && { attachedImage }),
      });
    } finally {
      clearInterval(typingInterval);
      await dismissProgressMessage();
    }

    await safeSendMessage(bot, chatId, formatAssistantReplyForTelegram(response), {
      reply_to_message_id: msg.message_id,
      parse_mode: 'HTML',
    });
  } catch (error) {
    await dismissProgressMessage();
    logger.error({ err: error }, 'Failed to process Telegram message');
    if (!response) {
      response = assistant.recoverFromExternalProcessingError(sessionId, text, error);
    } else {
      response = {
        reply:
          'Could not send the previous reply via Telegram (formatting or network). Your conversation context was already updated. Try again or send a short follow-up.',
        trace: [],
      };
    }
    await safeSendMessage(bot, chatId, formatAssistantReplyForTelegram(response), {
      reply_to_message_id: msg.message_id,
      parse_mode: 'HTML',
    });
  }
}

export function startTelegramBot(): TelegramBot {
  const bot = new TelegramBot(config.telegramBotToken, {
    polling: {
      autoStart: true,
      interval: 300,
      params: {
        timeout: 50,
      },
    },
  });

  bot.setMyCommands([
    { command: '/clear', description: 'Clear chat history' },
    { command: '/model', description: 'Switch LLM provider (ollama/gemini/nvidia)' },
    { command: '/status', description: 'Show session status' },
    { command: '/mcp', description: 'List MCP tools (e.g. /mcp tools)' },
  ]).catch((err) => logger.error({ err }, 'Failed to set Telegram commands'));

  bot.on('message', (msg) => {
    void handleMessage(bot, msg).catch((error) => {
      logger.error({ err: error }, 'Unhandled error in Telegram message handler');
    });
  });

  bot.on('polling_error', (error: Error & { code?: string }) => {
    const is409 =
      error?.code === 'ETELEGRAM' &&
      String(error?.message ?? '').includes('409');
    if (is409) {
      logger.error(
        { err: error },
        'Telegram 409 Conflict: another instance is polling. Ensure only one maikBot runs (stop duplicates, wait ~30s after restart).'
      );
    } else {
      logger.error({ err: error }, 'Telegram polling error');
    }
  });

  logger.info('Telegram bot started in long polling mode');
  return bot;
}
