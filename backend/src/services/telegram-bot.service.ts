import TelegramBot, { Message } from 'node-telegram-bot-api';
import { assistant } from '../core/assistant.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

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
    logger.error({ err: error, chatId }, 'Failed to send Telegram message');
  }
}

async function handleMessage(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!isAllowedUser(userId)) {
    logger.warn({ userId }, 'Blocked Telegram user (not in allowlist)');
    await safeSendMessage(bot, chatId, 'Access denied.');
    return;
  }

  if (!text) {
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4500);

    let response;
    try {
      response = await assistant.handleTextWithTrace(chatId, text);
    } finally {
      clearInterval(typingInterval);
    }

    const traceBlock =
      config.telegramShowAgentTrace && response.trace.length > 0
        ? `\n\n---\nAgent Trace:\n${response.trace.map((line) => `- ${line}`).join('\n')}`
        : '';
    await safeSendMessage(bot, chatId, `${response.reply}${traceBlock}`.slice(0, 4096), {
      reply_to_message_id: msg.message_id,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to process Telegram message');
    await safeSendMessage(
      bot,
      chatId,
      'Internal processing error. Check backend logs and Ollama/MCP connectivity.'
    );
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

  bot.on('message', (msg) => {
    void handleMessage(bot, msg).catch((error) => {
      logger.error({ err: error }, 'Unhandled error in Telegram message handler');
    });
  });

  bot.on('polling_error', (error) => {
    logger.error({ err: error }, 'Telegram polling error');
  });

  logger.info('Telegram bot started in long polling mode');
  return bot;
}
