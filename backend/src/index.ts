import { startTelegramBot } from './services/telegram-bot.service.js';
import { startWhatsAppBot } from './services/whatsapp-bot.service.js';
import { startHeartbeat } from './services/heartbeat.service.js';
import { startPaperlessWebhookServer } from './services/paperless-webhook.server.js';
import { setChannelSenderDeps } from './services/channel-sender.service.js';
import { logger } from './logger.js';
import { llmService } from './services/llm.service.js';
import { config } from './config.js';
import { acquireSingleInstanceLock } from './single-instance-lock.js';

acquireSingleInstanceLock();

async function bootstrap(): Promise<void> {
  logger.info('Bootstrapping maikBot backend');

  const health = await llmService.healthCheckAll();
  for (const [provider, ok] of Object.entries(health)) {
    if (ok) {
      logger.info({ provider }, 'LLM provider is reachable');
    } else {
      logger.warn({ provider }, 'LLM provider is not reachable');
    }
  }

  logger.info({ active: llmService.modelLabel }, 'Active LLM provider');

  if (config.allowedTelegramUserIds.size > 0) {
    logger.info(
      { count: config.allowedTelegramUserIds.size },
      'Telegram allowlist is active'
    );
  } else {
    if (config.telegramAllowEmptyAllowlist) {
      logger.warn(
        'Telegram allowlist is empty and TELEGRAM_ALLOW_EMPTY_ALLOWLIST=true: every Telegram user can talk to the bot'
      );
    } else {
      logger.fatal(
        'Telegram allowlist is empty. Refusing to start. Set ALLOWED_TELEGRAM_USER_IDS or explicitly allow this by setting TELEGRAM_ALLOW_EMPTY_ALLOWLIST=true.'
      );
      process.exit(1);
    }
  }

  const telegramBot = startTelegramBot();

  let whatsAppSend: ((jid: string, text: string) => Promise<boolean>) | undefined;
  if (config.whatsappEnabled) {
    const wa = await startWhatsAppBot();
    if (wa) {
      whatsAppSend = wa.sendMessage;
      logger.info('WhatsApp channel started');
    } else {
      logger.warn('WhatsApp enabled but failed to start');
    }
  }

  setChannelSenderDeps({
    telegramBot,
    sendWhatsApp: whatsAppSend,
  });

  startHeartbeat();
  startPaperlessWebhookServer();
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start backend');
  process.exit(1);
});
