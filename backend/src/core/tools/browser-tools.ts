/**
 * Browser automation tool (Playwright-based).
 * Similar to OpenClaw's browser tool: navigate, snapshot, screenshot, click, type.
 * Runs in an isolated headless Chromium by default.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { analyzeImage, VISION_PROMPT_WEB_PAGE } from '../../services/vision.service.js';
import type { ToolDefinition } from '../../services/llm.types.js';

export interface ToolExecResult {
  ok: boolean;
  output: string;
}

let browserInstance: Browser | null = null;
let pageInstance: Page | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  browserInstance = await chromium.launch({
    headless: config.browserHeadless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  logger.info('Browser launched (headless=%s)', config.browserHeadless);
  return browserInstance;
}

async function getPage(): Promise<Page> {
  if (pageInstance && !pageInstance.isClosed()) {
    return pageInstance;
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  pageInstance = await context.newPage();
  pageInstance.setDefaultTimeout(config.browserTimeoutMs);
  return pageInstance;
}

function isPrivateOrLocalhost(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
      return true;
    }
    const parts = host.split('.');
    const first = parts[0];
    if (
      first === '10' ||
      first === '192' ||
      first === '172' ||
      (first === '169' && parts[1] === '254')
    ) {
      return true;
    }
  } catch {
    /* invalid URL */
  }
  return false;
}

async function browserNavigate(url: string): Promise<ToolExecResult> {
  const trimmed = url.trim();
  if (!trimmed) {
    return { ok: false, output: 'url is required for navigate action.' };
  }
  let href = trimmed;
  if (!href.startsWith('http://') && !href.startsWith('https://')) {
    href = `https://${href}`;
  }
  if (isPrivateOrLocalhost(href)) {
    return {
      ok: false,
      output:
        'Navigation to localhost or private network is blocked for security. Only public URLs are allowed.',
    };
  }
  try {
    const page = await getPage();
    const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    const status = response?.status() ?? 'unknown';
    const finalUrl = page.url();
    return {
      ok: response?.ok() ?? false,
      output: `Navigated to ${finalUrl}. HTTP status: ${status}. Use browser_snapshot to see page content.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, url: href }, 'browser navigate failed');
    return { ok: false, output: `Navigation failed: ${msg}` };
  }
}

async function browserSnapshot(): Promise<ToolExecResult> {
  try {
    const page = await getPage();
    const url = page.url();
    if (url === 'about:blank' || !url) {
      return {
        ok: true,
        output: 'No page loaded. Use browser with action=navigate and a url first.',
      };
    }
    const [title, bodyText, links, buttons] = await page.evaluate(() => {
      const title = document.title || '';
      const body = document.body;
      const bodyText = body?.innerText?.slice(0, 15000) || '';
      const linkEls = Array.from(document.querySelectorAll('a[href]'));
      const links = linkEls.slice(0, 80).map((a, i) => {
        const href = (a as HTMLAnchorElement).href;
        const text = (a as HTMLElement).innerText?.trim().slice(0, 80) || href;
        return `[${i + 1}] ${text} -> ${href}`;
      });
      const buttonEls = Array.from(
        document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
      );
      const buttons = buttonEls.slice(0, 30).map((el, i) => {
        const text = (el as HTMLElement).innerText?.trim().slice(0, 60) || (el as HTMLInputElement).value || `button ${i + 1}`;
        return `[b${i + 1}] ${text}`;
      });
      return [title, bodyText, links, buttons];
    });
    const linkBlock = links.length ? '\n\nLinks (use ref for click):\n' + links.join('\n') : '';
    const buttonBlock = buttons.length ? '\n\nButtons (use ref for click):\n' + buttons.join('\n') : '';
    const truncated = bodyText.length >= 15000 ? bodyText + '\n\n...(truncated)' : bodyText;
    return {
      ok: true,
      output: `Title: ${title}\nURL: ${url}\n\nContent:\n${truncated}${linkBlock}${buttonBlock}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'browser snapshot failed');
    return { ok: false, output: `Snapshot failed: ${msg}` };
  }
}

async function browserScreenshot(): Promise<ToolExecResult> {
  try {
    const page = await getPage();
    const url = page.url();
    if (url === 'about:blank' || !url) {
      return { ok: false, output: 'No page loaded. Navigate first.' };
    }
    const dir = join(tmpdir(), 'maikbot-browser');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `screenshot-${randomUUID()}.png`);
    await page.screenshot({ path: filePath, type: 'png', fullPage: false });
    return {
      ok: true,
      output: `Screenshot saved to ${filePath}. The user can view this image.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'browser screenshot failed');
    return { ok: false, output: `Screenshot failed: ${msg}` };
  }
}

async function browserScreenshotAnalyze(): Promise<ToolExecResult> {
  try {
    const page = await getPage();
    const url = page.url();
    if (url === 'about:blank' || !url) {
      return { ok: false, output: 'No page loaded. Navigate first.' };
    }
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    const result = await analyzeImage(Buffer.from(buf), 'image/png', VISION_PROMPT_WEB_PAGE);
    if (!result.ok) {
      return { ok: false, output: result.description };
    }
    return {
      ok: true,
      output: `Page: ${url}\n\nVision analysis:\n${result.description}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'browser screenshot analyze failed');
    return { ok: false, output: `Screenshot analyze failed: ${msg}` };
  }
}

async function browserClick(selector: string): Promise<ToolExecResult> {
  const s = selector.trim();
  if (!s) {
    return { ok: false, output: 'selector is required for click action.' };
  }
  try {
    const page = await getPage();
    const elem = page.locator(s).first();
    await elem.click({ timeout: config.browserTimeoutMs });
    return { ok: true, output: `Clicked: ${s}. Use browser_snapshot to see updated page.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, selector: s }, 'browser click failed');
    return { ok: false, output: `Click failed: ${msg}` };
  }
}

async function browserType(selector: string, text: string): Promise<ToolExecResult> {
  const s = selector.trim();
  if (!s) {
    return { ok: false, output: 'selector is required for type action.' };
  }
  const t = typeof text === 'string' ? text : String(text ?? '');
  try {
    const page = await getPage();
    const elem = page.locator(s).first();
    await elem.fill(t, { timeout: config.browserTimeoutMs });
    return { ok: true, output: `Typed "${t.slice(0, 50)}${t.length > 50 ? '...' : ''}" into ${s}.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, selector: s }, 'browser type failed');
    return { ok: false, output: `Type failed: ${msg}` };
  }
}

async function browserClose(): Promise<ToolExecResult> {
  try {
    if (pageInstance && !pageInstance.isClosed()) {
      await pageInstance.context().close();
      pageInstance = null;
    }
    if (browserInstance && browserInstance.isConnected()) {
      await browserInstance.close();
      browserInstance = null;
    }
    return { ok: true, output: 'Browser closed.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Close failed: ${msg}` };
  }
}

export function getBrowserTools(): {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
}[] {
  if (!config.browserEnabled) {
    return [];
  }

  const tools: {
    definition: ToolDefinition;
    execute: (args: Record<string, unknown>) => Promise<ToolExecResult>;
  }[] = [
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_navigate',
          description:
            'Navigate the browser to a URL. Use for opening web pages. Only public URLs allowed (no localhost/private IPs).',
          parameters: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', description: 'URL to open (e.g. https://example.com)' },
            },
          },
        },
      },
      execute: async (args) => {
        const url = typeof args.url === 'string' ? args.url : String(args.url ?? '');
        return browserNavigate(url);
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_snapshot',
          description:
            'Get a text snapshot of the current page: title, content, links, buttons. Use after navigate to understand the page. Links/buttons have refs for click.',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: () => browserSnapshot(),
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_screenshot',
          description: 'Capture a screenshot of the current page (saved to file). Use when the user wants to see the page.',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: () => browserScreenshot(),
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_screenshot_analyze',
          description:
            'Take a screenshot and analyze it with vision AI (Gemini or Ollama LLaVA). Returns a text description of the page content, layout, buttons, links, forms. Use this when you need to "see" the page (e.g. complex layouts, images, or when browser_snapshot misses content).',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: () => browserScreenshotAnalyze(),
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_click',
          description:
            'Click an element. Use CSS selector or text from snapshot (e.g. "a:has-text(\'Login\')" or "button").',
          parameters: {
            type: 'object',
            required: ['selector'],
            properties: {
              selector: {
                type: 'string',
                description: 'CSS selector or Playwright locator (e.g. "a:has-text(\'Submit\')")',
              },
            },
          },
        },
      },
      execute: async (args) => {
        const selector = typeof args.selector === 'string' ? args.selector : String(args.selector ?? '');
        return browserClick(selector);
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_type',
          description: 'Type text into an input/textarea. Use after snapshot to find the right selector.',
          parameters: {
            type: 'object',
            required: ['selector', 'text'],
            properties: {
              selector: {
                type: 'string',
                description: 'Selector for input/textarea (e.g. "input[name=search]")',
              },
              text: { type: 'string', description: 'Text to type' },
            },
          },
        },
      },
      execute: async (args) => {
        const selector = typeof args.selector === 'string' ? args.selector : String(args.selector ?? '');
        const text = typeof args.text === 'string' ? args.text : String(args.text ?? '');
        return browserType(selector, text);
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_close',
          description: 'Close the browser and free resources. Call when done browsing.',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: () => browserClose(),
    },
  ];

  return tools;
}
