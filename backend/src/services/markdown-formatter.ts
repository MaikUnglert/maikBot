/**
 * Converts Markdown to platform-specific formatting.
 * Telegram: HTML (parse_mode: 'HTML')
 * WhatsApp: *bold* _italic_ ~strikethrough~ ```monospace``` (native formatting)
 */

const PLACEHOLDER_CODE_BLOCK = '\u0001CODE_BLOCK\u0002';
const PLACEHOLDER_INLINE_CODE = '\u0001INLINE_CODE\u0002';
const PLACEHOLDER_LINK = '\u0001LINK\u0002';
const PLACEHOLDER_BOLD = '\u0001BOLD\u0002';

function replacer(placeholder: string): RegExp {
  return new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

export function formatMarkdownForTelegram(text: string): string {
  const { result, codeBlocks, inlineCodes, links } = extractProtected(text);

  let out = result
    // Bold: **text** or __text__ (do before italic)
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/__(.+?)__/gs, '<b>$1</b>')
    // Italic: *text* or _text_ (single, not double)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '<i>$1</i>')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/gs, '<i>$1</i>')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    // Blockquote: > line
    .replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>')
    // Restore placeholders (order matters: code block before inline before link)
    .replace(replacer(PLACEHOLDER_CODE_BLOCK), () => {
      const raw = codeBlocks.shift() ?? '';
      const escaped = raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<pre>${escaped}</pre>`;
    })
    .replace(replacer(PLACEHOLDER_INLINE_CODE), () => {
      const raw = inlineCodes.shift() ?? '';
      const escaped = raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<code>${escaped}</code>`;
    })
    .replace(replacer(PLACEHOLDER_LINK), () => {
      const link = links.shift();
      if (!link) return '';
      const escapedText = link.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<a href="${link.url}">${escapedText}</a>`;
    });

  // Escape remaining & < >
  out = out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Unescape our own tags (they got escaped above)
  out = out
    .replace(/&lt;b&gt;/g, '<b>')
    .replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;i&gt;/g, '<i>')
    .replace(/&lt;\/i&gt;/g, '</i>')
    .replace(/&lt;s&gt;/g, '<s>')
    .replace(/&lt;\/s&gt;/g, '</s>')
    .replace(/&lt;code&gt;/g, '<code>')
    .replace(/&lt;\/code&gt;/g, '</code>')
    .replace(/&lt;pre&gt;/g, '<pre>')
    .replace(/&lt;\/pre&gt;/g, '</pre>')
    .replace(/&lt;a href="([^"]*)"&gt;/g, '<a href="$1">')
    .replace(/&lt;\/a&gt;/g, '</a>');

  return out;
}

export function formatMarkdownForWhatsApp(text: string): string {
  const { result, codeBlocks, inlineCodes, links } = extractProtected(text);
  const boldTexts: string[] = [];

  let out = result
    // Bold: **text** or __text__ → placeholder first (avoid converting to italic later)
    .replace(/\*\*(.+?)\*\*/gs, (_, m) => {
      boldTexts.push(m);
      return PLACEHOLDER_BOLD;
    })
    .replace(/__(.+?)__/gs, (_, m) => {
      boldTexts.push(m);
      return PLACEHOLDER_BOLD;
    })
    // Italic: *text* or _text_ → _text_ (WhatsApp uses _ for italic)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '_$1_')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/gs, '_$1_')
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/gs, '~$1~')
    // Restore placeholders
    .replace(replacer(PLACEHOLDER_CODE_BLOCK), () => {
      const raw = codeBlocks.shift() ?? '';
      return `\`\`\`\n${raw}\`\`\``;
    })
    .replace(replacer(PLACEHOLDER_INLINE_CODE), () => {
      const raw = inlineCodes.shift() ?? '';
      return `\`\`\`${raw}\`\`\``;
    })
    .replace(replacer(PLACEHOLDER_BOLD), () => `*${boldTexts.shift() ?? ''}*`)
    .replace(replacer(PLACEHOLDER_LINK), () => {
      const link = links.shift();
      if (!link) return '';
      return `${link.text} (${link.url})`;
    });

  return out;
}

interface Extracted {
  result: string;
  codeBlocks: string[];
  inlineCodes: string[];
  links: { text: string; url: string }[];
}

function extractProtected(text: string): Extracted {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const links: { text: string; url: string }[] = [];

  let result = text;

  // 1. Code blocks ```...``` (including optional language)
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, content) => {
    codeBlocks.push(content.trimEnd());
    return PLACEHOLDER_CODE_BLOCK;
  });

  // 2. Inline code `...` (avoid matching inside placeholders)
  result = result.replace(/`([^`\n]+)`/g, (_, content) => {
    inlineCodes.push(content);
    return PLACEHOLDER_INLINE_CODE;
  });

  // 3. Links [text](url)
  result = result.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, linkText, url) => {
    links.push({ text: linkText, url: url.trim() });
    return PLACEHOLDER_LINK;
  });

  return { result, codeBlocks, inlineCodes, links };
}
