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

async function handleMessage(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!isAllowedUser(userId)) {
    logger.warn({ userId }, 'Blocked Telegram user (not in allowlist)');
    await bot.sendMessage(chatId, 'Access denied.');
    return;
  }

  if (!text) {
    return;
  }

  try {
    const response = await assistant.handleText(text);
    await bot.sendMessage(chatId, response, {
      reply_to_message_id: msg.message_id,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to process Telegram message');
    await bot.sendMessage(
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
    void handleMessage(bot, msg);
  });

  bot.on('polling_error', (error) => {
    logger.error({ err: error }, 'Telegram polling error');
  });

  logger.info('Telegram bot started in long polling mode');
  return bot;
}
