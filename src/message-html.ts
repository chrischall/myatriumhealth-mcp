// Message bodies (and letters) arrive as Epic "fmtConv" HTML: a wrapper div, an
// inline <style> block, one div[data-paragraph] per paragraph and inline
// images served by Image/Load. One body can run to tens of KB of markup, most
// of it styling, so readers get it as plain text with the images named.

import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';
import { imageFileNameFromSrc } from './portal-path.js';

export interface MessageImage {
  /** 1-based, matching the `[image N: ...]` placeholder in the text. */
  index: number;
  /** Pass to mah_get_image. Absent when the image is not a portal image. */
  fileName?: string;
  width?: number;
  height?: number;
  alt?: string;
  /** Why it will not be fetched: it points somewhere other than the portal. */
  rejected?: string;
}

export interface MessageText {
  text: string;
  images: MessageImage[];
}

const DROP = new Set(['style', 'script', 'noscript', 'template', 'iframe', 'svg', 'head', 'title', 'object', 'embed']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figure',
  'figcaption', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'body', 'html',
]);
/** A block boundary: one line break however many blocks meet there. */
const SOFT = '\u0001';
/** An empty paragraph: a blank line. */
const BLANK = '\u0002';
/** Deeper than this, the rest of a subtree is read as flat text. */
const MAX_DEPTH = 200;

function dimension(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function rejectedReason(src: string): string {
  const s = src.trim();
  if (/^data:/i.test(s)) return 'not a portal image (data URI)';
  try {
    const host = new URL(s, 'https://my.atriumhealth.org/myatriumhealth/').hostname;
    return `not a portal image (${host})`;
  } catch {
    return 'not a portal image';
  }
}

/** Render an Epic message body as readable text plus its inline images. */
export function messageHtmlToText(html: string | null | undefined): MessageText {
  if (html === null || html === undefined || html.trim() === '') return { text: '', images: [] };
  const root = parse(html, { comment: false, blockTextElements: { pre: true } });
  const out: string[] = [];
  const images: MessageImage[] = [];

  const image = (el: HTMLElement): void => {
    const index = images.length + 1;
    const src = el.getAttribute('src') ?? '';
    const fileName = imageFileNameFromSrc(src);
    const img: MessageImage = { index };
    if (fileName !== undefined) img.fileName = fileName;
    else img.rejected = rejectedReason(src);
    const width = dimension(el.getAttribute('width'));
    const height = dimension(el.getAttribute('height'));
    if (width !== undefined) img.width = width;
    if (height !== undefined) img.height = height;
    const alt = el.getAttribute('alt')?.replace(/\s+/g, ' ').trim();
    if (alt !== undefined && alt !== '') img.alt = alt;
    images.push(img);
    out.push(
      fileName !== undefined
        ? ` [image ${index}: fileName=${fileName}] `
        : ` [image ${index}: not fetched — not a portal image] `,
    );
  };

  const walk = (node: Node, depth: number): void => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      out.push(node.text.replace(/[\s ]+/g, ' '));
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName?.toLowerCase() ?? '';
    if (DROP.has(tag)) return;
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    if (tag === 'img') {
      image(el);
      return;
    }
    if (depth > MAX_DEPTH) {
      out.push(el.text.replace(/[\s ]+/g, ' '));
      return;
    }
    if (tag === 'li') out.push(SOFT, '- ');
    else if (tag === 'td' || tag === 'th') out.push(' | ');
    else if (BLOCK.has(tag)) out.push(SOFT);
    const before = out.length;
    for (const child of el.childNodes) walk(child, depth + 1);
    if (tag === 'a') {
      const href = el.getAttribute('href')?.trim() ?? '';
      const shown = out.slice(before).join('').trim();
      if (/^(https?:|mailto:)/i.test(href) && href !== shown) out.push(` (${href})`);
    }
    if (BLOCK.has(tag)) {
      // An empty paragraph is how Epic spaces paragraphs apart: keep it as
      // one blank line. Adjacent non-empty blocks just break the line.
      if (/^[\s\u00a0\u0001]*$/.test(out.slice(before).join(''))) {
        out.length = before;
        out.push(SOFT, BLANK, SOFT);
      } else {
        out.push(SOFT);
      }
    }
  };
  walk(root, 0);

  const lines = out
    .join('')
    .replace(/[ \t]*\u0001[\u0001 \t]*/g, '\n')
    .replaceAll(BLANK, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    // A list bullet left alone on its line by a nested block.
    .map((l) => (l === '-' ? '' : l))
    .map((l) => l.replace(/^\|\s*/, ''));
  const kept: string[] = [];
  for (const l of lines) {
    if (l === '' && (kept.length === 0 || kept.at(-1) === '')) continue;
    kept.push(l);
  }
  while (kept.at(-1) === '') kept.pop();
  return { text: kept.join('\n'), images };
}
