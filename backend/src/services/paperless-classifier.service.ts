/**
 * Paperless-ngx document classifier.
 * Receives webhooks when documents are consumed, analyzes them with the LLM,
 * and updates Paperless with suggested title, tags, correspondent, document type.
 *
 * Inspired by Paperless-AI (clusterzx/paperless-ai, MIT License).
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { llmService } from './llm.service.js';
import type { LlmMessage } from './llm.types.js';

const CONTENT_MAX_LENGTH = 32_000; // chars, ~8k tokens

const SYSTEM_PROMPT = `You are a document analyzer. Your task is to analyze documents and extract relevant information.

Analyze the document content and extract the following information into a structured JSON object:

1. title: Create a concise, meaningful title for the document
2. correspondent: Identify the sender/institution but do not include addresses
3. tags: Select up to 4 relevant thematic tags
4. document_type: e.g. Invoice, Contract, Letter, Receipt, etc.
5. document_date: Extract the document date (format: YYYY-MM-DD)
6. language: Determine the document language (e.g. "de" or "en")

Important rules:
- For tags: Check existing tags first. Use only relevant categories. Maximum 4 tags, at least 1. Output language = document language.
- For title: Short and concise, NO ADDRESSES. Mention invoice/order number if available. Output language = document language.
- For correspondent: Shortest form (e.g. "Amazon" not "Amazon EU SARL, German branch").
- For document_date: YYYY-MM-DD. If unclear, use "1970-01-01".
- For language: "de", "en", "es", etc. If unclear, use "und".

Return EXCLUSIVELY a valid JSON object. No other text. No markdown code fences.
{
  "title": "string",
  "correspondent": "string",
  "tags": ["tag1", "tag2"],
  "document_type": "string",
  "document_date": "YYYY-MM-DD",
  "language": "string"
}`;

interface PaperlessDocument {
  id: number;
  title: string;
  content: string;
  tags: number[];
  correspondent: number | null;
  document_type: number | null;
  created?: string;
}

interface PaperlessTag {
  id: number;
  name: string;
}

interface PaperlessCorrespondent {
  id: number;
  name: string;
}

interface PaperlessDocumentType {
  id: number;
  name: string;
}

interface AnalysisResult {
  title: string;
  correspondent: string;
  tags: string[];
  document_type: string;
  document_date: string;
  language: string;
}

async function paperlessFetch<T>(
  pathOrUrl: string,
  options: RequestInit = {}
): Promise<T> {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : (() => {
        const base = config.paperlessUrl!.replace(/\/$/, '').replace(/\/api\/?$/, '');
        const p = pathOrUrl.startsWith('/') ? pathOrUrl.slice(1) : pathOrUrl;
        return `${base}/api/${p}`;
      })();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Token ${config.paperlessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperless API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function getDocument(documentId: number): Promise<PaperlessDocument | null> {
  try {
    const doc = await paperlessFetch<PaperlessDocument>(`documents/${documentId}/`);
    return doc;
  } catch (err) {
    logger.error({ err, documentId }, 'Failed to fetch document from Paperless');
    return null;
  }
}

async function listTags(): Promise<PaperlessTag[]> {
  const result = await paperlessFetch<{ results: PaperlessTag[]; next: string | null }>(
    'tags/?page_size=500'
  );
  const tags = result.results ?? [];
  let next = result.next;
  while (next) {
    const page = await paperlessFetch<{ results: PaperlessTag[]; next: string | null }>(next);
    tags.push(...(page.results ?? []));
    next = page.next;
  }
  return tags;
}

async function listCorrespondents(): Promise<PaperlessCorrespondent[]> {
  const result = await paperlessFetch<{
    results: PaperlessCorrespondent[];
    next: string | null;
  }>('correspondents/?page_size=500');
  const list = result.results ?? [];
  let next = result.next;
  while (next) {
    const page = await paperlessFetch<{
      results: PaperlessCorrespondent[];
      next: string | null;
    }>(next);
    list.push(...(page.results ?? []));
    next = page.next;
  }
  return list;
}

async function listDocumentTypes(): Promise<PaperlessDocumentType[]> {
  const result = await paperlessFetch<{
    results: PaperlessDocumentType[];
    next: string | null;
  }>('document_types/?page_size=500');
  const list = result.results ?? [];
  let next = result.next;
  while (next) {
    const page = await paperlessFetch<{
      results: PaperlessDocumentType[];
      next: string | null;
    }>(next);
    list.push(...(page.results ?? []));
    next = page.next;
  }
  return list;
}

function findExistingTag(name: string, tags: PaperlessTag[]): PaperlessTag | null {
  const n = name.trim().toLowerCase();
  return tags.find((t) => t.name.toLowerCase() === n) ?? null;
}

function findExistingCorrespondent(name: string, list: PaperlessCorrespondent[]): PaperlessCorrespondent | null {
  const n = name.trim().toLowerCase();
  return list.find((c) => c.name.toLowerCase() === n) ?? null;
}

function findExistingDocumentType(name: string, list: PaperlessDocumentType[]): PaperlessDocumentType | null {
  const n = name.trim().toLowerCase();
  return list.find((d) => d.name.toLowerCase() === n) ?? null;
}

async function createTag(name: string): Promise<PaperlessTag | null> {
  try {
    const created = await paperlessFetch<PaperlessTag>('tags/', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    });
    return created;
  } catch (err) {
    logger.warn({ err, name }, 'Failed to create tag');
    return null;
  }
}

async function createCorrespondent(name: string): Promise<PaperlessCorrespondent | null> {
  try {
    const created = await paperlessFetch<PaperlessCorrespondent>('correspondents/', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    });
    return created;
  } catch (err) {
    logger.warn({ err, name }, 'Failed to create correspondent');
    return null;
  }
}

async function createDocumentType(name: string): Promise<PaperlessDocumentType | null> {
  try {
    const created = await paperlessFetch<PaperlessDocumentType>('document_types/', {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        matching_algorithm: 1,
        match: '',
        is_insensitive: true,
      }),
    });
    return created;
  } catch (err) {
    logger.warn({ err, name }, 'Failed to create document type');
    return null;
  }
}

async function patchDocument(
  documentId: number,
  updates: {
    title?: string;
    tags?: number[];
    correspondent?: number | null;
    document_type?: number | null;
    created?: string;
  }
): Promise<boolean> {
  try {
    await paperlessFetch(`documents/${documentId}/`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    return true;
  } catch (err) {
    logger.error({ err, documentId }, 'Failed to patch document');
    return false;
  }
}

function parseJsonFromLlm(text: string): AnalysisResult | null {
  let raw = text.trim();
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) raw = codeBlock[1].trim();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    const correspondent = typeof parsed.correspondent === 'string' ? parsed.correspondent : '';
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const document_type = typeof parsed.document_type === 'string' ? parsed.document_type : '';
    const document_date = typeof parsed.document_date === 'string' ? parsed.document_date : '1970-01-01';
    const language = typeof parsed.language === 'string' ? parsed.language : 'und';
    return { title, correspondent, tags, document_type, document_date, language };
  } catch {
    return null;
  }
}

function buildUserPrompt(
  content: string,
  existingTags: string[],
  existingCorrespondents: string[],
  existingDocTypes: string[]
): string {
  let truncated = content;
  if (truncated.length > CONTENT_MAX_LENGTH) {
    truncated = truncated.slice(0, CONTENT_MAX_LENGTH) + '\n\n[... truncated ...]';
    logger.info({ original: content.length, truncated: CONTENT_MAX_LENGTH }, 'Truncated document content');
  }

  const parts: string[] = [];
  if (existingTags.length > 0) {
    parts.push(`Existing tags (prefer these): ${existingTags.join(', ')}`);
  }
  if (existingCorrespondents.length > 0) {
    parts.push(`Existing correspondents (prefer these): ${existingCorrespondents.join(', ')}`);
  }
  if (existingDocTypes.length > 0) {
    parts.push(`Existing document types (prefer these): ${existingDocTypes.join(', ')}`);
  }
  if (parts.length > 0) {
    return `${parts.join('\n\n')}\n\nDocument content:\n\n${truncated}`;
  }
  return `Document content:\n\n${truncated}`;
}

export async function classifyDocument(documentId: number): Promise<{
  ok: boolean;
  error?: string;
  applied?: Partial<AnalysisResult>;
}> {
  if (!config.paperlessUrl || !config.paperlessToken) {
    return { ok: false, error: 'Paperless not configured' };
  }

  const doc = await getDocument(documentId);
  if (!doc) {
    return { ok: false, error: 'Document not found' };
  }

  const content = doc.content?.trim() ?? '';
  if (!content) {
    logger.warn({ documentId }, 'Document has no content (OCR may not have run yet)');
    return { ok: false, error: 'Document has no content' };
  }

  const [allTags, allCorrespondents, allDocTypes] = await Promise.all([
    listTags(),
    listCorrespondents(),
    listDocumentTypes(),
  ]);

  const existingTags = allTags.map((t) => t.name);
  const existingCorrespondents = allCorrespondents.map((c) => c.name);
  const existingDocTypes = allDocTypes.map((d) => d.name);

  const userPrompt = buildUserPrompt(content, existingTags, existingCorrespondents, existingDocTypes);

  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let llmContent: string;
  try {
    const result = await llmService.chat(messages, []);
    llmContent = result.content?.trim() ?? '';
  } catch (err) {
    logger.error({ err, documentId }, 'LLM call failed for document classification');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const analysis = parseJsonFromLlm(llmContent);
  if (!analysis) {
    logger.warn({ documentId, raw: llmContent.slice(0, 500) }, 'Failed to parse LLM response as JSON');
    return { ok: false, error: 'Invalid JSON from LLM' };
  }

  const tagIds: number[] = [...doc.tags];
  for (const tagName of analysis.tags) {
    if (!tagName) continue;
    let tag = findExistingTag(tagName, allTags);
    if (!tag && !config.paperlessRestrictToExistingTags) {
      tag = await createTag(tagName);
      if (tag) allTags.push(tag);
    }
    if (tag && !tagIds.includes(tag.id)) {
      tagIds.push(tag.id);
    }
  }

  let correspondentId: number | null = doc.correspondent;
  if (!correspondentId && analysis.correspondent) {
    let corr = findExistingCorrespondent(analysis.correspondent, allCorrespondents);
    if (!corr && !config.paperlessRestrictToExistingCorrespondents) {
      corr = await createCorrespondent(analysis.correspondent);
      if (corr) allCorrespondents.push(corr);
    }
    if (corr) correspondentId = corr.id;
  }

  let documentTypeId: number | null = doc.document_type;
  if (!documentTypeId && analysis.document_type) {
    let dt = findExistingDocumentType(analysis.document_type, allDocTypes);
    if (!dt && !config.paperlessRestrictToExistingDocTypes) {
      dt = await createDocumentType(analysis.document_type);
      if (dt) allDocTypes.push(dt);
    }
    if (dt) documentTypeId = dt.id;
  }

  const title =
    analysis.title && analysis.title.length <= 128
      ? analysis.title
      : analysis.title
        ? analysis.title.slice(0, 124) + '…'
        : doc.title;

  const updates: Parameters<typeof patchDocument>[1] = {
    title,
    tags: tagIds,
  };
  if (correspondentId !== undefined) updates.correspondent = correspondentId;
  if (documentTypeId !== undefined) updates.document_type = documentTypeId;
  if (analysis.document_date && analysis.document_date !== '1970-01-01') {
    updates.created = analysis.document_date;
  }

  const patched = await patchDocument(documentId, updates);
  if (!patched) {
    return { ok: false, error: 'Failed to update document', applied: analysis };
  }

  logger.info(
    { documentId, title, correspondent: analysis.correspondent, tags: analysis.tags },
    'Document classified successfully'
  );

  return { ok: true, applied: analysis };
}
