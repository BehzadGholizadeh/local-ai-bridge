import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Converts the rendered HTML of an assistant reply back to Markdown, so API clients
// get code fences, lists and tables instead of flattened text.

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
td.use(gfm);

const DROP = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEMPLATE']);
td.remove((node) => DROP.has(node.nodeName.toUpperCase()));

const classes = (node: unknown): string[] =>
  ((node as HTMLElement | null)?.getAttribute?.('class') ?? '').split(/\s+/);

// Code blocks: both sites wrap <pre> with a header ("python", "Copy code"); keep only the <code>.
td.addRule('codeBlock', {
  filter: (node) => node.nodeName === 'PRE',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const code = el.querySelector('code');
    const cls = `${code?.getAttribute('class') ?? ''} ${el.getAttribute('class') ?? ''}`;
    const lang = /(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? '';
    const text = ((code ?? el).textContent ?? '').replace(/\n$/, '');
    const fence = text.includes('```') ? '````' : '```';
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  },
});

// KaTeX math: recover the original TeX from the MathML annotation.
td.addRule('katex', {
  filter: (node) => node.nodeName === 'SPAN' && classes(node).includes('katex'),
  replacement: (content, node) => {
    const tex = (node as HTMLElement).querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!tex) return content;
    return classes(node.parentNode).includes('katex-display') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
  },
});

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  return td
    .turndown(html)
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
