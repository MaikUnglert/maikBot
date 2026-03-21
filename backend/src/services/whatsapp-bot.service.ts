import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  areJidsSameUser,
  type WASocket,
  type proto,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import {
  assistant,
  type AssistantProgressCallback,
  type AssistantResponse,
} from '../core/assistant.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sessionIdWhatsApp } from '../core/channel-types.js';

function extractText(msg: proto.IMessage): string | undefined {
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  return undefined;
}

function isFromMe(msg: WAMessage): boolean {
  return msg.key.fromMe ?? false;
}

function getRemoteJid(msg: WAMessage): string | undefined {
  const jid = msg.key.remoteJid;
  if (!jid) return undefined;
  if (
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@lid')
  ) {
    return jid;
  }
  return undefined;
}

function formatAssistantReplyForWhatsApp(response: AssistantResponse): string {
  const traceBlock =
    config.telegramShowAgentTrace && response.trace.length > 0
      ? `\n\n---\nAgent Trace:\n${response.trace.map((line) => `- ${line}`).join('\n')}`
      : '';
  return `${response.reply}${traceBlock}`.slice(0, 4000);
}

function isAllowedSender(jid: string): boolean {
  if (!config.whatsappAllowedFrom || config.whatsappAllowedFrom.size === 0) {
    return config.whatsappAllowEmptyAllowlist;
  }
  const normalized = jid.replace(/@.*$/, '').replace(/\D/g, '');
  for (const allowed of config.whatsappAllowedFrom) {
    const allowedNorm = allowed.replace(/\D/g, '');
    if (normalized === allowedNorm || allowed === '*') return true;
  }
  return false;
}

function isAllowedGroupJid(jid: string): boolean {
  if (!jid.endsWith('@g.us')) return false;
  if (!config.whatsappGroupsEnabled) return false;
  return true;
}

export interface WhatsAppBotResult {
  sock: WASocket | null;
  sendMessage: (jid: string, text: string) => Promise<boolean>;
}

export async function startWhatsAppBot(): Promise<WhatsAppBotResult | null> {
  if (!config.whatsappEnabled) return null;

  const authDir = config.whatsappAuthDir;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let sock: WASocket | null = null;
  const credsMe = state.creds as { me?: { id?: string; lid?: string } };
  let myJid: string | null = credsMe?.me?.id ?? null;
  let myLid: string | null = credsMe?.me?.lid ?? null;
  const sentMessageIds = new Set<string>();
  const MAX_SENT_IDS = 200;
  const sendMessage = async (jid: string, text: string): Promise<boolean> => {
    if (!sock) return false;
    try {
      const sent = await sock.sendMessage(jid, { text: text.slice(0, 4000) });
      if (sent?.key?.id) {
        sentMessageIds.add(sent.key.id);
        if (sentMessageIds.size > MAX_SENT_IDS) {
          const first = sentMessageIds.values().next().value;
          if (first) sentMessageIds.delete(first);
        }
      }
      return true;
    } catch (error) {
      logger.error({ err: error, jid }, 'WhatsApp: failed to send message');
      return false;
    }
  };

  const displayQR = async (qr: string): Promise<void> => {
    if (!config.whatsappPrintQR) return;
    try {
      const { default: QRCode } = await import('qrcode');
      const qrStr = await QRCode.toString(qr, { type: 'terminal', small: true });
      console.log('\n📱 Scan this QR code with WhatsApp:\n' + qrStr + '\n');
    } catch {
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`;
      console.log('\n📱 Open this URL to see the QR code, then scan with WhatsApp:\n', url, '\n');
    }
  };

  const connect = async (): Promise<void> => {
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      auth: state,
      version,
      browser: ['MaikBot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await displayQR(qr);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const delayMs =
          statusCode === DisconnectReason.connectionReplaced ? 15000 : 5000;
        logger.warn(
          { statusCode, shouldReconnect, delayMs },
          'WhatsApp connection closed'
        );
        if (statusCode === 405) {
          logger.warn(
            'If this keeps failing, try: rm -rf data/whatsapp-auth/* and restart (clears corrupted session)'
          );
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
          logger.warn(
            'Connection was replaced (another device or instance). Ensure only one maikBot and no duplicate WhatsApp Web sessions.'
          );
        }
        sock = null;
        if (shouldReconnect) {
          setTimeout(connect, delayMs);
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp connected');
      }
    });

    sock.ev.on('creds.update', (update) => {
      saveCreds(update);
      const me = update as { me?: { id?: string; lid?: string } };
      if (me.me?.id) myJid = me.me.id;
      if (me.me?.lid) myLid = me.me.lid;
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        if (msg.key?.id && sentMessageIds.has(msg.key.id)) {
          sentMessageIds.delete(msg.key.id);
          logger.debug({ id: msg.key.id }, 'WhatsApp: skipped own echo');
          continue;
        }
        const fromMe = isFromMe(msg);
        const remoteJid = getRemoteJid(msg);
        const text = extractText(msg.message ?? {});
        logger.debug(
          { fromMe, remoteJid, myJid, type, hasText: !!text?.trim() },
          'WhatsApp: message received'
        );
        if (!remoteJid) continue;
        const isSelfChat =
          fromMe &&
          (areJidsSameUser(remoteJid, myJid) ||
            (!!myLid && areJidsSameUser(remoteJid, myLid)));

        if (config.whatsappSelfOnly) {
          if (!isSelfChat) {
            logger.debug({ remoteJid }, 'WhatsApp: skipped (selfOnly, not self-chat)');
            continue;
          }
        } else {
          if (fromMe && !isSelfChat) {
            logger.debug({ remoteJid }, 'WhatsApp: skipped (fromMe but not self-chat)');
            continue;
          }
          if (!isSelfChat) {
            const isGroup = remoteJid.endsWith('@g.us');
            const senderJid = msg.key.participant ?? remoteJid;
            if (isGroup) {
              if (!isAllowedGroupJid(remoteJid)) continue;
              if (!isAllowedSender(senderJid)) {
                logger.debug({ senderJid }, 'WhatsApp: ignored group message from non-allowlisted sender');
                continue;
              }
            } else {
              if (!isAllowedSender(remoteJid)) {
                logger.warn({ remoteJid }, 'WhatsApp: blocked user (not in allowlist)');
                await sendMessage(remoteJid, 'Access denied.');
                continue;
              }
            }
          }
        }

        if (!text?.trim()) {
          logger.debug('WhatsApp: skipped (no text)');
          continue;
        }

        logger.info({ remoteJid, text: text.slice(0, 50) }, 'WhatsApp: processing message');

        const sessionId = sessionIdWhatsApp(remoteJid);

        const buildOnProgress = (): AssistantProgressCallback => {
          return async () => {
            /* WhatsApp has no typing/status overlay like Telegram; could add reaction later */
          };
        };

        try {
          const response = await assistant.handleTextWithTrace(sessionId, text.trim(), {
            onProgress: buildOnProgress(),
          });
          const formatted = formatAssistantReplyForWhatsApp(response);
          await sendMessage(remoteJid, formatted);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'WhatsApp: failed to process message');
          const fallback = assistant.recoverFromExternalProcessingError(
            sessionId,
            text.trim(),
            error
          );
          await sendMessage(remoteJid, formatAssistantReplyForWhatsApp(fallback));
        }
      }
    });
  };

  await connect();
  return { sock, sendMessage };
}
