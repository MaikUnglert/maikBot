import http from 'node:http';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { classifyDocument } from './paperless-classifier.service.js';

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function checkAuth(req: http.IncomingMessage): boolean {
  const secret = config.paperlessClassifyWebhookSecret;
  if (!secret) return true;

  const auth = req.headers.authorization;
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token === secret;
}

export function startPaperlessWebhookServer(): void {
  if (!config.paperlessUrl || !config.paperlessToken) {
    logger.info('Paperless not configured; webhook server not started');
    return;
  }

  const server = http.createServer(async (req, res) => {
    const reqUrl = req.url ?? '';
    const [path, queryStr] = reqUrl.split('?');
    if (req.method !== 'POST' || path !== '/api/paperless-classify') {
      res.writeHead(404);
      res.end();
      return;
    }

    const query = new URLSearchParams(queryStr ?? '');

    if (!checkAuth(req)) {
      logger.warn('Paperless webhook: unauthorized request');
      sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    let body: string;
    try {
      body = await parseBody(req);
    } catch (err) {
      logger.error({ err }, 'Paperless webhook: failed to read body');
      sendJson(res, 400, { ok: false, error: 'Invalid body' });
      return;
    }

    let payload: { documentId?: number; document_id?: number; doc_url?: string } = {};
    if (body?.trim()) {
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
        return;
      }
    }

    // documentId from: JSON body, query params, or doc_url (body/query)
    let documentId: number | undefined =
      typeof payload.documentId === 'number' ? payload.documentId : payload.document_id;
    if (documentId == null) {
      const qId = query.get('documentId') ?? query.get('document_id');
      if (qId) documentId = Number.parseInt(qId, 10);
    }
    if (documentId == null) {
      const docUrl = payload.doc_url ?? query.get('doc_url');
      if (typeof docUrl === 'string') {
        const match = docUrl.match(/\/documents\/(\d+)(?:\/|$)/);
        documentId = match ? Number.parseInt(match[1], 10) : undefined;
      }
    }
    if (typeof documentId !== 'number' || !Number.isInteger(documentId) || documentId < 1) {
      logger.warn(
        { body: body?.slice(0, 200), query: Object.fromEntries(query.entries()) },
        'Paperless webhook: missing documentId/doc_url'
      );
      sendJson(res, 400, {
        ok: false,
        error: 'documentId, document_id, or doc_url required (body JSON or query params)',
      });
      return;
    }

    logger.info({ documentId }, 'Paperless webhook: classifying document');

    try {
      const result = await classifyDocument(documentId);
      if (result.ok) {
        sendJson(res, 200, { ok: true, applied: result.applied });
      } else {
        sendJson(res, 500, { ok: false, error: result.error });
      }
    } catch (err) {
      logger.error({ err, documentId }, 'Paperless webhook: classification failed');
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.listen(config.paperlessClassifyPort, () => {
    logger.info(
      { port: config.paperlessClassifyPort, url: config.paperlessUrl },
      'Paperless classifier webhook server started'
    );
  });

  server.on('error', (err) => {
    logger.error({ err, port: config.paperlessClassifyPort }, 'Paperless webhook server error');
  });
}
