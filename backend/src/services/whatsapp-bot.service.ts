import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  areJidsSameUser,
  downloadMediaMessage,
  getContentType,
  type WASocket,
  type proto,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assistant,
  type AssistantProgressCallback,
  type AssistantResponse,
} from '../core/assistant.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sessionIdWhatsApp } from '../core/channel-types.js';
import {
  isScanEnabled,
  startOrAddPage,
  finishSession,
  cancelSession,
  getSession,
  setPendingConfirm,
  handleConfirm,
  getPendingConfirmByTarget,
} from './scan.service.js';
import { formatMarkdownForWhatsApp } from './markdown-formatter.js';

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
  return formatMarkdownForWhatsApp(`${response.reply}${traceBlock}`).slice(0, 4000);
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

    sock.ev.on('creds.update', (upd) => {
      void saveCreds();
      const me = upd as { me?: { id?: string; lid?: string } };
      if (me.me?.id) myJid = me.me.id;
      if (me.me?.lid) myLid = me.me.lid;
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Only process real-time new messages. Skip 'append'/'prepend' (history sync) –
      // otherwise we'd reply to every old message when reconnecting.
      if (type !== 'notify') {
        logger.debug({ type, count: messages.length }, 'WhatsApp: skipped history sync');
        return;
      }
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
          (areJidsSameUser(remoteJid, myJid ?? '') ||
            (!!myLid && areJidsSameUser(remoteJid, myLid ?? '')));

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

        const targetKey = `wa:${remoteJid}`;
        const trimmedText = text.trim().toLowerCase();

        const pendingConfirmId = getPendingConfirmByTarget(targetKey);
        if (pendingConfirmId) {
          const isJa = /^(ja|yes|senden|send|ok)$/i.test(trimmedText);
          const isNein = /^(nein|no|verwerfen|discard|cancel)$/i.test(trimmedText);
          if (isJa || isNein) {
            const result = await handleConfirm(
              pendingConfirmId,
              isJa ? 'send' : 'discard'
            );
            if (result.ok) {
              if (isJa) {
                const base = config.paperlessUrl?.replace(/\/$/, '').replace(/\/api\/?$/, '') ?? '';
                const link = result.documentId && base ? `\n${base}/documents/${result.documentId}` : '';
                await sendMessage(
                  remoteJid,
                  `✓ Sent to Paperless.${result.documentId ? ` (ID: ${result.documentId})` : ''}${link}`
                );
              } else if (isNein) {
                await sendMessage(remoteJid, 'Discarded.');
              }
            } else {
              await sendMessage(remoteJid, `Error: ${result.error ?? 'Unknown'}`);
            }
            continue;
          }
        }

        // PDF document upload to Paperless
        const contentType = getContentType(msg.message ?? {});
        if (
          contentType === 'documentMessage' &&
          config.paperlessUrl &&
          config.paperlessToken &&
          sock
        ) {
          const doc = msg.message?.documentMessage;
          const isPdf =
            doc?.mimetype === 'application/pdf' ||
            (doc?.fileName ?? '').toLowerCase().endsWith('.pdf');
          if (isPdf && doc) {
            try {
              const buf = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                { logger, reuploadRequest: sock.updateMediaMessage }
              );
              if (buf && Buffer.isBuffer(buf)) {
                const dir = config.scanDataDir;
                await fs.mkdir(dir, { recursive: true });
                const filename = doc.fileName ?? 'document.pdf';
                const tempPath = path.join(dir, `upload_${randomUUID()}.pdf`);
                await fs.writeFile(tempPath, buf);

                const confirmId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
                setPendingConfirm(confirmId, 'upload', targetKey, tempPath);

                await sendMessage(
                  remoteJid,
                  `PDF received (${filename}). Reply "yes" to send to Paperless, "no" to discard.`
                );
              } else {
                await sendMessage(remoteJid, 'Could not download the PDF.');
              }
            } catch (err) {
              logger.error({ err }, 'WhatsApp: failed to download document');
              await sendMessage(remoteJid, 'Error downloading the PDF.');
            }
            continue;
          }
        }

        if (!text?.trim()) {
          logger.debug('WhatsApp: skipped (no text)');
          continue;
        }

        if (trimmedText.startsWith('/scan')) {
          const arg = trimmedText.replace(/^\/scan\s*/, '').trim();
          if (!isScanEnabled()) {
            await sendMessage(
              remoteJid,
              'Scan is not configured. Set SCAN_BACKEND (hp-webscan or scanimage), SCAN_HP_PRINTER_IP for hp-webscan, or configure SANE/scanimage (see SCAN_SANE_DEVICE).'
            );
            continue;
          }
          if (arg === 'cancel' || arg === 'abbrechen') {
            const result = cancelSession(targetKey);
            await sendMessage(remoteJid, result.ok ? result.message! : result.message ?? 'No session.');
            continue;
          }
          if (arg === 'done' || arg === 'fertig') {
            const finishResult = await finishSession(targetKey);
            if (!finishResult.ok) {
              await sendMessage(remoteJid, finishResult.error ?? 'Error.');
              continue;
            }
            if (!finishResult.pdfPath) {
              await sendMessage(remoteJid, 'No PDF was created.');
              continue;
            }
            try {
              const pdfBuf = await fs.readFile(finishResult.pdfPath);
              if (sock) {
                await sock.sendMessage(remoteJid, {
                  document: pdfBuf,
                  mimetype: 'application/pdf',
                  fileName: `scan_${finishResult.sessionId ?? 'doc'}.pdf`,
                });
              } else {
                await sendMessage(remoteJid, 'Connection lost. Please try again later.');
                continue;
              }
              const confirmId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
              setPendingConfirm(
                confirmId,
                finishResult.sessionId ?? confirmId,
                targetKey,
                finishResult.pdfPath
              );
              await sendMessage(
                remoteJid,
                `Preview (${finishResult.pageCount} page(s)). Reply "yes" to send to Paperless, "no" to discard.`
              );
            } catch (err) {
              logger.error({ err }, 'WhatsApp: failed to send scan preview');
              await sendMessage(remoteJid, 'Could not send the preview.');
            }
            continue;
          }
          const addResult = await startOrAddPage(targetKey);
          await sendMessage(
            remoteJid,
            addResult.ok ? addResult.message! : addResult.message ?? addResult.error ?? 'Scan failed.'
          );
          continue;
        }

        const t = trimmedText.toLowerCase();
        if (
          isScanEnabled() &&
          getSession(targetKey) &&
          (t === 'fertig' || t === 'done' || t === 'scan fertig' || t === 'scan done')
        ) {
          const finishResult = await finishSession(targetKey);
          if (finishResult.ok && finishResult.pdfPath) {
            try {
              const pdfBuf = await fs.readFile(finishResult.pdfPath);
              if (sock) {
                await sock.sendMessage(remoteJid, {
                  document: pdfBuf,
                  mimetype: 'application/pdf',
                  fileName: `scan_${finishResult.sessionId ?? 'doc'}.pdf`,
                });
              }
              const confirmId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
              setPendingConfirm(confirmId, finishResult.sessionId ?? confirmId, targetKey, finishResult.pdfPath);
              await sendMessage(
                remoteJid,
                `Vorschau (${finishResult.pageCount} Seite(n)). Antworte mit "ja" um zu Paperless zu senden, "nein" zum Verwerfen.`
              );
            } catch (err) {
              logger.error({ err }, 'WhatsApp: failed to send scan preview');
              await sendMessage(remoteJid, 'Vorschau konnte nicht gesendet werden.');
            }
          } else {
            await sendMessage(remoteJid, finishResult.error ?? 'Kein PDF erstellt.');
          }
          continue;
        }

        logger.info({ remoteJid, text: text.slice(0, 50) }, 'WhatsApp: processing message');

        const sessionId = sessionIdWhatsApp(remoteJid);

        const PROGRESS_EDIT_THROTTLE_MS = 900;
        let progressMessageKey: WAMessageKey | undefined;
        let lastProgressEditAt = -Number.MAX_VALUE;

        const replaceProgressWithReply = async (text: string): Promise<void> => {
          if (!sock) return;
          if (progressMessageKey) {
            const key = progressMessageKey;
            progressMessageKey = undefined;
            try {
              await sock.sendMessage(key.remoteJid!, {
                text: text.slice(0, 4000),
                edit: key,
              });
              return;
            } catch {
              /* edit failed, fall through to send new message */
            }
          }
          await sendMessage(remoteJid, text);
        };

        const buildOnProgress = (): AssistantProgressCallback => {
          return async (phase: string) => {
            if (!progressMessageKey || !sock) return;
            const now = Date.now();
            if (now - lastProgressEditAt < PROGRESS_EDIT_THROTTLE_MS) return;
            lastProgressEditAt = now;
            try {
              await sock.sendMessage(remoteJid, {
                text: `⏳ ${phase}`,
                edit: progressMessageKey,
              });
            } catch {
              /* e.g. message not modified */
            }
          };
        };

        const presenceInterval =
          sock && remoteJid
            ? setInterval(() => {
                sock?.sendPresenceUpdate('composing', remoteJid).catch(() => {});
              }, 8000)
            : undefined;

        if (sock) {
          try {
            const statusSent = await sock.sendMessage(remoteJid, { text: '⏳ Working…' });
            if (statusSent?.key) {
              progressMessageKey = statusSent.key;
              if (statusSent.key.id) {
                sentMessageIds.add(statusSent.key.id);
                if (sentMessageIds.size > MAX_SENT_IDS) {
                  const first = sentMessageIds.values().next().value;
                  if (first) sentMessageIds.delete(first);
                }
              }
            }
          } catch (err) {
            logger.warn({ err }, 'WhatsApp: could not send progress status message');
          }
        }

        try {
          const response = await assistant.handleTextWithTrace(sessionId, text.trim(), {
            onProgress: buildOnProgress(),
          });
          const formatted = formatAssistantReplyForWhatsApp(response);
          await replaceProgressWithReply(formatted);
        } catch (error) {
          logger.error({ err: error, sessionId }, 'WhatsApp: failed to process message');
          const fallback = assistant.recoverFromExternalProcessingError(
            sessionId,
            text.trim(),
            error
          );
          await replaceProgressWithReply(formatAssistantReplyForWhatsApp(fallback));
        } finally {
          if (presenceInterval) clearInterval(presenceInterval);
          sock?.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
      }
    });
  };

  await connect();
  return { sock, sendMessage };
}
