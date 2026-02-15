import { startTelegramBot } from './services/telegram-bot.service.js';
import { logger } from './logger.js';
import { ollamaService } from './services/ollama.service.js';
import { config } from './config.js';

async function bootstrap(): Promise<void> {
  logger.info('Bootstrapping maikBot backend');

  const ollamaHealthy = await ollamaService.healthCheck();
  if (!ollamaHealthy) {
    logger.warn(
      { ollamaBaseUrl: config.ollamaBaseUrl },
      'Ollama is not reachable at startup'
    );
  } else {
    logger.info({ model: config.ollamaModel }, 'Ollama is reachable');
  }

  if (config.allowedTelegramUserIds.size > 0) {
    logger.info(
      { count: config.allowedTelegramUserIds.size },
      'Telegram allowlist is active'
    );
  } else {
    logger.warn('Telegram allowlist is empty: every Telegram user can talk to the bot');
  }

  startTelegramBot();
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start backend');
  process.exit(1);
});
