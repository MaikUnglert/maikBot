/**
 * Channel-agnostic session identifiers.
 * Format: "tg:12345" (Telegram) or "wa:491234567890@s.whatsapp.net" or "wa:123@lid" (WhatsApp).
 */
export type SessionId = string;

export function sessionIdTelegram(chatId: number): SessionId {
  return `tg:${chatId}`;
}

export function sessionIdWhatsApp(jid: string): SessionId {
  return `wa:${jid}`;
}

export function parseSessionId(sessionId: SessionId): {
  channel: 'telegram' | 'whatsapp';
  targetId: string;
} | null {
  if (sessionId.startsWith('tg:')) {
    const targetId = sessionId.slice(3);
    if (targetId && /^\d+$/.test(targetId)) {
      return { channel: 'telegram', targetId };
    }
  }
  if (sessionId.startsWith('wa:')) {
    const targetId = sessionId.slice(3);
    if (targetId && targetId.includes('@')) {
      return { channel: 'whatsapp', targetId };
    }
  }
  return null;
}

export function isTelegramSession(sessionId: SessionId): boolean {
  return sessionId.startsWith('tg:');
}

export function isWhatsAppSession(sessionId: SessionId): boolean {
  return sessionId.startsWith('wa:');
}
