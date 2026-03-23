import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
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
import {
  isScanEnabled,
  startOrAddPage,
  finishSession,
  cancelSession,
  setPendingConfirm,
  handleConfirm,
  getPendingConfirmByTarget,
} from './scan.service.js';

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
  if (t === '/clear' || t === '/status' || t === '/info' || t === '/help' || t === '/commands' || t === '/update' || t === '/reload') return false;
  if (t.startsWith('/model')) return false;
  if (t.startsWith('/scan')) return false;
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

async function downloadTelegramDocument(bot: TelegramBot, fileId: string): Promise<Buffer | null> {
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
    logger.warn({ err, fileId }, 'Failed to download Telegram document');
    return null;
  }
}

async function handleDocumentUpload(bot: TelegramBot, msg: Message): Promise<boolean> {
  const doc = msg.document;
  if (!doc || !config.paperlessUrl || !config.paperlessToken) return false;

  const isPdf =
    doc.mime_type === 'application/pdf' || (doc.file_name ?? '').toLowerCase().endsWith('.pdf');
  if (!isPdf) return false;

  const chatId = msg.chat.id;
  const targetKey = `tg:${chatId}`;

  await bot.sendChatAction(chatId, 'typing');
  const buf = await downloadTelegramDocument(bot, doc.file_id);
  if (!buf) {
    await safeSendMessage(bot, chatId, 'PDF konnte nicht heruntergeladen werden.', {
      reply_to_message_id: msg.message_id,
    });
    return true;
  }

  const dir = config.scanDataDir;
  await fs.mkdir(dir, { recursive: true });
  const filename = doc.file_name ?? 'document.pdf';
  const tempPath = path.join(dir, `upload_${randomUUID()}.pdf`);
  await fs.writeFile(tempPath, buf);

  const confirmId = randomConfirmId();
  setPendingConfirm(confirmId, 'upload', targetKey, tempPath);

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✓ Zu Paperless senden', callback_data: `scan_confirm_${confirmId}_send` },
        { text: '✗ Verwerfen', callback_data: `scan_confirm_${confirmId}_discard` },
      ],
    ],
  };

  await safeSendMessage(
    bot,
    chatId,
    `PDF erhalten (${filename}). Zu Paperless senden?`,
    { reply_to_message_id: msg.message_id, reply_markup: keyboard }
  );
  return true;
}

function providerSupportsNativeVision(): boolean {
  const provider = llmService.getActiveProviderName();
  return provider === 'nvidia' || provider === 'gemini';
}

function hasFallbackVision(): boolean {
  return !!(config.geminiApiKey || config.ollamaBaseUrl);
}

async function handleScanCommand(
  bot: TelegramBot,
  msg: Message,
  text: string
): Promise<boolean> {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const t = text.trim().toLowerCase();

  if (!t.startsWith('/scan')) return false;
  if (!isAllowedUser(userId)) return false;
  if (!isScanEnabled()) {
    await safeSendMessage(
      bot,
      chatId,
      'Scan nicht konfiguriert. Setze SCAN_BACKEND (hp-webscan/scanimage) und SCAN_HP_PRINTER_IP oder nutze scanimage.',
      { reply_to_message_id: msg.message_id }
    );
    return true;
  }

  const arg = t.replace(/^\/scan\s*/, '').trim();

  const targetKey = `tg:${chatId}`;

  if (arg === 'cancel' || arg === 'abbrechen') {
    const result = cancelSession(targetKey);
    await safeSendMessage(bot, chatId, result.ok ? result.message! : result.message ?? 'Keine Session.', {
      reply_to_message_id: msg.message_id,
    });
    return true;
  }

  if (arg === 'done' || arg === 'fertig') {
    await bot.sendChatAction(chatId, 'upload_document');
    const finishResult = await finishSession(targetKey);
    if (!finishResult.ok) {
      await safeSendMessage(bot, chatId, finishResult.error ?? 'Fehler.', {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    if (!finishResult.pdfPath) {
      await safeSendMessage(bot, chatId, 'Kein PDF erstellt.', {
        reply_to_message_id: msg.message_id,
      });
      return true;
    }
    try {
      const pdfBuf = await fs.readFile(finishResult.pdfPath);
      const caption = `Vorschau (${finishResult.pageCount} Seite(n)). Zu Paperless senden?`;
      const confirmId = randomConfirmId();
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✓ Zu Paperless senden', callback_data: `scan_confirm_${confirmId}_send` },
            { text: '✗ Verwerfen', callback_data: `scan_confirm_${confirmId}_discard` },
          ],
        ],
      };
      const sent = await bot.sendDocument(chatId, pdfBuf, {
        caption,
        reply_to_message_id: msg.message_id,
        reply_markup: keyboard,
      });
      setPendingConfirm(
        confirmId,
        finishResult.sessionId ?? confirmId,
        targetKey,
        finishResult.pdfPath,
        sent.message_id
      );
    } catch (err) {
      logger.error({ err }, 'Failed to send scan preview');
      await safeSendMessage(bot, chatId, 'Vorschau konnte nicht gesendet werden.', {
        reply_to_message_id: msg.message_id,
      });
    }
    return true;
  }

  // /scan or /scan <anything else> → add page
  const addResult = await startOrAddPage(targetKey);
  await safeSendMessage(
    bot,
    chatId,
    addResult.ok ? addResult.message! : addResult.message ?? addResult.error ?? 'Scan fehlgeschlagen.',
    { reply_to_message_id: msg.message_id }
  );
  return true;
}

function randomConfirmId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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

  const targetKey = `tg:${chatId}`;
  const pendingConfirmId = getPendingConfirmByTarget(targetKey);
  if (pendingConfirmId) {
    const t = text.trim().toLowerCase();
    const isJa = /^(ja|yes|senden|send|ok)$/i.test(t);
    const isNein = /^(nein|no|verwerfen|discard|cancel)$/i.test(t);
    if (isJa || isNein) {
      const result = await handleConfirm(pendingConfirmId, isJa ? 'send' : 'discard');
      if (result.ok) {
        if (isJa) {
          const base = config.paperlessUrl?.replace(/\/$/, '').replace(/\/api\/?$/, '') ?? '';
          const link =
            result.documentId && base ? `\n${base}/documents/${result.documentId}` : '';
          await safeSendMessage(
            bot,
            chatId,
            `✓ Dokument an Paperless gesendet.${result.documentId ? ` (ID: ${result.documentId})` : ''}${link}`,
            { reply_to_message_id: msg.message_id }
          );
        } else {
          await safeSendMessage(bot, chatId, 'Verworfen.', {
            reply_to_message_id: msg.message_id,
          });
        }
      } else {
        await safeSendMessage(bot, chatId, `Fehler: ${result.error ?? 'Unbekannt'}`, {
          reply_to_message_id: msg.message_id,
        });
      }
      return;
    }
  }

  const docHandled = await handleDocumentUpload(bot, msg);
  if (docHandled) return;

  const scanHandled = await handleScanCommand(bot, msg, text);
  if (scanHandled) return;

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

  const replaceProgressWithReply = async (formatted: string): Promise<void> => {
    if (progressMessageId !== undefined) {
      const id = progressMessageId;
      progressMessageId = undefined;
      try {
        await bot.editMessageText(formatted, {
          chat_id: chatId,
          message_id: id,
          parse_mode: 'HTML',
        });
        return;
      } catch {
        /* edit failed, fall through to send new message */
      }
    }
    await safeSendMessage(bot, chatId, formatted, {
      reply_to_message_id: msg.message_id,
      parse_mode: 'HTML',
    });
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
    }

    await replaceProgressWithReply(formatAssistantReplyForTelegram(response));
  } catch (error) {
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
    await replaceProgressWithReply(formatAssistantReplyForTelegram(response));
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
    { command: 'info', description: 'List all commands' },
    { command: 'clear', description: 'Clear chat history' },
    { command: 'model', description: 'Switch LLM provider (ollama/gemini/nvidia)' },
    { command: 'update', description: 'Pull updates, build, restart' },
    { command: 'reload', description: 'Build and restart (for self-improvements)' },
    { command: 'status', description: 'Show session status' },
    { command: 'scan', description: 'Scan document, /scan done, /scan cancel' },
    { command: 'mcp', description: 'List MCP tools (e.g. /mcp tools)' },
  ]).catch((err) => logger.error({ err }, 'Failed to set Telegram commands'));

  bot.on('callback_query', async (query: CallbackQuery) => {
    const data = query.data;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const userId = query.from?.id;

    if (!data?.startsWith('scan_confirm_') || !chatId || messageId === undefined) return;
    if (!isAllowedUser(userId)) {
      await bot.answerCallbackQuery(query.id, { text: 'Access denied.' });
      return;
    }

    const match = data.match(/^scan_confirm_(.+)_(send|discard)$/);
    if (!match) return;
    const [, confirmId, action] = match;

    const result = await handleConfirm(confirmId, action as 'send' | 'discard');
    await bot.answerCallbackQuery(query.id, {
      text: result.ok
        ? action === 'send'
          ? 'An Paperless gesendet.'
          : 'Verworfen.'
        : result.error ?? 'Fehler.',
    });

    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch {
      /* ignore */
    }

    if (action === 'send' && result.ok) {
      const base = config.paperlessUrl?.replace(/\/$/, '').replace(/\/api\/?$/, '') ?? '';
      const link =
        result.documentId && base ? `\n${base}/documents/${result.documentId}` : '';
      await bot.sendMessage(
        chatId,
        `✓ Dokument an Paperless gesendet.${result.documentId ? ` (ID: ${result.documentId})` : ''}${link}`,
        { reply_to_message_id: messageId }
      );
    } else if (action === 'send' && !result.ok && result.error) {
      await bot.sendMessage(chatId, `Fehler beim Hochladen: ${result.error}`, {
        reply_to_message_id: messageId,
      });
    }
  });

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
