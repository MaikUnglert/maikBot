/**
 * Scan service: HP WebScan, SANE scanimage, session management, PDF creation.
 * Integrates with Paperless for document upload.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { PDFDocument } from 'pdf-lib';

export type ScanBackend = 'hp-webscan' | 'scanimage';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

/** Target key: "tg:12345" (Telegram) or "wa:jid@s.whatsapp.net" (WhatsApp). */
export type ScanTargetKey = string;

export interface ScanSession {
  id: string;
  targetKey: ScanTargetKey;
  pages: string[];
  sessionDir: string;
  createdAt: number;
  status: 'scanning' | 'preview' | 'done';
}

export interface PendingConfirm {
  sessionId: string;
  targetKey: ScanTargetKey;
  pdfPath: string;
  messageId?: number;
  createdAt: number;
}

const sessions = new Map<string, ScanSession>();
const pendingConfirms = new Map<string, PendingConfirm>();
/** targetKey -> confirmId, for WhatsApp text confirmation. */
const pendingByTarget = new Map<ScanTargetKey, string>();

async function ensureScanDir(): Promise<string> {
  const dir = config.scanDataDir;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function hpWebscanScan(): Promise<Buffer | null> {
  const ip = config.scanHpPrinterIp;
  if (!ip) return null;

  try {
    const { WebScan } = await import('hp-webscan-client');
    const client = new WebScan({ ip });
    const buffer = await client.scanToBuffer({
      color: true,
      format: 'image/jpeg',
      source: 'Platen',
      resolution: 300,
    });
    if (!buffer) return null;
    if (Buffer.isBuffer(buffer)) return buffer;
    return Buffer.from(new Uint8Array(buffer as ArrayBuffer));
  } catch (err) {
    logger.error({ err, ip }, 'HP WebScan failed');
    return null;
  }
}

async function runScanimage(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('scanimage', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (ch) => { stderr += ch.toString(); });
    proc.on('close', (code) => {
      resolve({ ok: code === 0, stderr });
    });
    proc.on('error', (err) => {
      logger.error({ err }, 'scanimage spawn failed');
      resolve({ ok: false, stderr: err.message });
    });
  });
}

async function scanimageScan(sessionDir: string, pageNum: number): Promise<string | null> {
  const device = config.scanSaneDevice;
  const outPath = path.join(sessionDir, `page_${String(pageNum).padStart(3, '0')}.jpg`);
  const args = [
    ...(device ? ['-d', device] : []),
    '--format=jpeg',
    '--resolution=300',
    '--mode=Color',
    '--source=Flatbed',
    '-o',
    outPath,
  ];

  const runOnce = async (): Promise<string | null> => {
    const { ok, stderr } = await runScanimage(args);
    if (ok) return outPath;

    const diag: Record<string, unknown> = {
      code: 1,
      stderr: stderr.slice(0, 500),
      device,
      outPath,
      args,
      cwd: process.cwd(),
    };
    if (typeof process.getuid === 'function') diag.uid = process.getuid();
    if (typeof process.getgid === 'function') diag.gid = process.getgid();
    logger.error(diag, 'scanimage failed');
    return null;
  };

  const first = await runOnce();
  if (first) return first;

  // Retry once after delay; airscan "Invalid argument" can be transient (scanner busy, network blip)
  await new Promise((r) => setTimeout(r, 2000));
  logger.info({ device }, 'scanimage retry');
  return runOnce();
}

async function createPdfFromImages(imagePaths: string[], outPath: string): Promise<boolean> {
  try {
    const doc = await PDFDocument.create();

    for (const imgPath of imagePaths) {
      const buf = await fs.readFile(imgPath);
      const ext = path.extname(imgPath).toLowerCase();
      const page = doc.addPage();
      let img;
      if (ext === '.png') {
        img = await doc.embedPng(buf);
      } else {
        img = await doc.embedJpg(buf);
      }
      const { width, height } = img.scale(0.5);
      const pageW = page.getWidth();
      const pageH = page.getHeight();
      const scale = Math.min(pageW / width, pageH / height, 1);
      page.drawImage(img, {
        x: (pageW - width * scale) / 2,
        y: (pageH - height * scale) / 2,
        width: width * scale,
        height: height * scale,
      });
    }

    const pdfBytes = await doc.save();
    await fs.writeFile(outPath, pdfBytes);
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to create PDF from images');
    return false;
  }
}

async function uploadToPaperless(pdfPath: string): Promise<{ ok: boolean; documentId?: number; error?: string }> {
  if (!config.paperlessUrl || !config.paperlessToken) {
    return { ok: false, error: 'Paperless not configured' };
  }

  const base = config.paperlessUrl.replace(/\/$/, '').replace(/\/api\/?$/, '');
  const url = `${base}/api/documents/post_document/`;

  const formData = new FormData();
  const blob = new Blob([await fs.readFile(pdfPath)], { type: 'application/pdf' });
  formData.append('document', blob, path.basename(pdfPath));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Token ${config.paperlessToken}` },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Paperless ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as { id?: number };
    return { ok: true, documentId: data.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      for (const p of s.pages) {
        fs.unlink(p).catch(() => {});
      }
      fs.rmdir(s.sessionDir).catch(() => {});
    }
  }
  for (const [id, p] of pendingConfirms.entries()) {
    if (now - p.createdAt > SESSION_TTL_MS) {
      pendingConfirms.delete(id);
      pendingByTarget.delete(p.targetKey);
      fs.unlink(p.pdfPath).catch(() => {});
    }
  }
}

export function isScanEnabled(): boolean {
  if (config.scanBackend === 'none') return false;
  if (config.scanBackend === 'hp-webscan') return !!config.scanHpPrinterIp;
  if (config.scanBackend === 'scanimage') return true;
  return false;
}

export function getSession(targetKey: ScanTargetKey): ScanSession | null {
  pruneExpired();
  return [...sessions.values()].find((s) => s.targetKey === targetKey) ?? null;
}

export async function startOrAddPage(targetKey: ScanTargetKey): Promise<{
  ok: boolean;
  pageCount?: number;
  error?: string;
  message?: string;
}> {
  if (!isScanEnabled()) {
    return {
      ok: false,
      error: 'Scan not configured (set SCAN_BACKEND, SCAN_HP_PRINTER_IP for hp-webscan, or scanimage/SANE)',
    };
  }

  pruneExpired();
  let session = getSession(targetKey);
  const isNew = !session;

  if (!session) {
    const dir = await ensureScanDir();
    const sessionId = randomUUID();
    const sessionDir = path.join(dir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    session = {
      id: sessionId,
      targetKey,
      pages: [],
      sessionDir,
      createdAt: Date.now(),
      status: 'scanning',
    };
    sessions.set(sessionId, session);
  }

  const pageNum = session.pages.length + 1;
  const baseDir = session.sessionDir;

  let pagePath: string | null = null;

  if (config.scanBackend === 'hp-webscan') {
    const buf = await hpWebscanScan();
    if (buf) {
      pagePath = path.join(baseDir, `page_${String(pageNum).padStart(3, '0')}.jpg`);
      await fs.writeFile(pagePath, buf);
    }
  } else if (config.scanBackend === 'scanimage') {
    pagePath = await scanimageScan(session.sessionDir, pageNum);
  }

  if (!pagePath) {
    if (isNew) {
      sessions.delete(session.id);
      fs.rmdir(session.sessionDir).catch(() => {});
    }
    return {
      ok: false,
      error: 'Scan failed',
      message:
        config.scanBackend === 'hp-webscan'
          ? 'WebScan failed. Is the printer reachable and WebScan enabled?'
          : 'scanimage failed. Is SANE/scanimage installed and the scanner connected?',
    };
  }

  session.pages.push(pagePath);
  return {
    ok: true,
    pageCount: session.pages.length,
    message:
      session.pages.length === 1
        ? 'Page 1 scanned. Scan another page with /scan or finish with /scan done.'
        : `${session.pages.length} page(s). Continue with /scan or finish with /scan done.`,
  };
}

export async function finishSession(targetKey: ScanTargetKey): Promise<{
  ok: boolean;
  pdfPath?: string;
  pageCount?: number;
  sessionId?: string;
  error?: string;
}> {
  pruneExpired();
  const session = getSession(targetKey);
  if (!session || session.pages.length === 0) {
    return { ok: false, error: 'No scan session. Start with /scan.' };
  }

  const dir = await ensureScanDir();
  const pdfPath = path.join(dir, `scan_${session.id}.pdf`);
  const created = await createPdfFromImages(session.pages, pdfPath);

  sessions.delete(session.id);
  for (const p of session.pages) {
    fs.unlink(p).catch(() => {});
  }
  fs.rmdir(session.sessionDir).catch(() => {});

  if (!created) {
    return { ok: false, error: 'PDF creation failed' };
  }

  return { ok: true, pdfPath, pageCount: session.pages.length, sessionId: session.id };
}

export function cancelSession(targetKey: ScanTargetKey): { ok: boolean; message?: string } {
  pruneExpired();
  const session = getSession(targetKey);
  if (!session) {
    return { ok: false, message: 'No active scan session.' };
  }

  sessions.delete(session.id);
  for (const p of session.pages) {
    fs.unlink(p).catch(() => {});
  }
  fs.rmdir(session.sessionDir).catch(() => {});
  return { ok: true, message: 'Scan cancelled.' };
}

export function setPendingConfirm(
  confirmId: string,
  _sessionId: string,
  targetKey: ScanTargetKey,
  pdfPath: string,
  messageId?: number
): void {
  pendingConfirms.set(confirmId, {
    sessionId: _sessionId,
    targetKey,
    pdfPath,
    messageId,
    createdAt: Date.now(),
  });
  pendingByTarget.set(targetKey, confirmId);
}

export function getPendingConfirmByTarget(targetKey: ScanTargetKey): string | null {
  return pendingByTarget.get(targetKey) ?? null;
}

export async function handleConfirm(
  confirmId: string,
  action: 'send' | 'discard'
): Promise<{ ok: boolean; pdfPath?: string; documentId?: number; error?: string }> {
  const pending = pendingConfirms.get(confirmId);
  if (!pending) {
    return { ok: false, error: 'Confirmation expired or invalid.' };
  }
  pendingConfirms.delete(confirmId);
  pendingByTarget.delete(pending.targetKey);

  if (action === 'discard') {
    await fs.unlink(pending.pdfPath).catch(() => {});
    return { ok: true };
  }

  const result = await uploadToPaperless(pending.pdfPath);
  await fs.unlink(pending.pdfPath).catch(() => {});

  if (result.ok) {
    return { ok: true, pdfPath: pending.pdfPath, documentId: result.documentId };
  }
  return { ok: false, error: result.error };
}

export function getPendingConfirm(confirmId: string): PendingConfirm | null {
  return pendingConfirms.get(confirmId) ?? null;
}
