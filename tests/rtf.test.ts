import { describe, expect, it } from 'vitest';
import { looksLikeRtf, rtfToText } from '../src/rtf.js';

// Synthetic RTF, in the shape Epic stores result text and values in.

describe('rtfToText', () => {
  it('drops the header groups and control words, keeping the text and paragraphs', () => {
    const rtf =
      '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}' +
      '{\\*\\generator Sample;}\\f0\\fs20 FINDINGS:\\par No sample finding.\\par\\par IMPRESSION:\\tab Normal.}';
    expect(rtfToText(rtf)).toBe('FINDINGS:\nNo sample finding.\n\nIMPRESSION:\tNormal.');
  });

  it('decodes hex and unicode escapes and literal braces', () => {
    expect(rtfToText("{\\rtf1 caf\\'e9 \\u8805? 5 \\{x\\}}")).toBe('café ≥ 5 {x}');
  });

  it('passes plain text through and never throws on junk', () => {
    expect(rtfToText('just text')).toBe('just text');
    expect(() => rtfToText('{\\rtf1 {{{ \\')).not.toThrow();
    expect(rtfToText('')).toBe('');
  });

  it('recognises RTF by its header', () => {
    expect(looksLikeRtf('  {\\rtf1 x}')).toBe(true);
    expect(looksLikeRtf('<p>x</p>')).toBe(false);
  });
});
