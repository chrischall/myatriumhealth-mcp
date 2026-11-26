// Epic keeps some result text (narratives, impressions, component values) as
// RTF, flagged `isRTF` / `isValueRtf`. Readers get plain text: paragraphs and
// tabs kept, every control word, font/colour table and destination dropped.
// Loose by design: malformed RTF degrades to whatever text it holds, never a throw.

/** Destinations whose contents are never text. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
  'headerl', 'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl',
  'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore',
]);

/** Whether a string is an RTF document. */
export function looksLikeRtf(s: string | null | undefined): boolean {
  return typeof s === 'string' && /^\s*\{\\rtf/.test(s);
}

/** Render RTF as plain text. Text that is not RTF is returned trimmed. */
export function rtfToText(rtf: string | null | undefined): string {
  if (typeof rtf !== 'string' || rtf === '') return '';
  if (!looksLikeRtf(rtf)) return rtf.trim();
  const out: string[] = [];
  // Per group: whether its text is skipped, and how many chars follow a \uN.
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  const emit = (t: string): void => {
    if (pendingSkip > 0) {
      const n = Math.min(pendingSkip, t.length);
      pendingSkip -= n;
      t = t.slice(n);
    }
    if (!skip && t !== '') out.push(t);
  };
  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const ch = rtf[i]!;
    if (ch === '{') {
      stack.push({ skip, uc });
      i++;
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top !== undefined) {
        skip = top.skip;
        uc = top.uc;
      }
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch !== '\\') {
      emit(ch);
      i++;
      continue;
    }
    // A control sequence.
    const next = rtf[i + 1];
    if (next === undefined) break;
    if (next === '\\' || next === '{' || next === '}') {
      emit(next);
      i += 2;
      continue;
    }
    if (next === "'") {
      const hex = rtf.slice(i + 2, i + 4);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code)) emit(String.fromCharCode(code));
      i += 4;
      continue;
    }
    if (next === '*') {
      // An ignorable destination: skip the whole group.
      skip = true;
      i += 2;
      continue;
    }
    if (next === '~') {
      emit(' ');
      i += 2;
      continue;
    }
    if (next === '\n' || next === '\r') {
      emit('\n');
      i += 2;
      continue;
    }
    const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i + 1, i + 46));
    if (m === null) {
      i += 2;
      continue;
    }
    const word = m[1]!;
    const arg = m[2] === undefined ? undefined : Number.parseInt(m[2], 10);
    i += 1 + m[0].length;
    if (SKIP_DESTINATIONS.has(word)) skip = true;
    else if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') emit('\n');
    else if (word === 'tab') emit('\t');
    else if (word === 'uc' && arg !== undefined) uc = arg;
    else if (word === 'u' && arg !== undefined) {
      emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
      pendingSkip = uc;
    }
  }
  return out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[  ]+/g, ' ').replace(/^ +| +$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
