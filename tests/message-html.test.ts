import { describe, expect, it } from 'vitest';
import { messageHtmlToText } from '../src/message-html.js';

// Synthetic markup modelled on the SHAPE of an Epic "fmtConv" message body: a
// wrapper div, an inline <style> block keyed to the wrapper id, one
// div[data-paragraph] per paragraph with styled spans, a bulleted list, and
// inline images served from Image/Load. No real message content.
const epicBody = [
  '<div id="fmtConv1234" class="fmtConv">',
  '<style nonce="00000000000000000000000000000000">',
  '#fmtConv1234 { line-height: normal; font-family: Arial; }',
  '#fmtConv1234 .p0_1234 { text-align: left; }',
  '#fmtConv1234 .s0_1234 { font-size: 0.9rem; white-space: pre-wrap; }',
  '</style>',
  '<div class="p0_1234" data-paragraph="0"><span class="s0_1234">Dear Sample Patient,</span></div>',
  '<div class="p0_1234" data-paragraph="1"><span class="s0_1234">&nbsp;</span></div>',
  '<div class="p0_1234" data-paragraph="2"><span class="s0_1234">Please read the steps &amp; follow them.</span></div>',
  '<div class="p0_1234" data-paragraph="3"><span class="s0_1234"> </span></div>',
  '<div class="p0_1234" data-paragraph="4"><span class="s0_1234"></span></div>',
  '<ul class="ul0_1234"><li class="li0_1234"><span>Step one</span></li><li><span>Step </span><b>two</b></li></ul>',
  '<div class="p0_1234" data-paragraph="5"><img class="i0_1234" src="/myatriumhealth/Image/Load?fileName=11111111-aaaa-4bbb-8ccc-000000000001" alt="Diagram &quot;A&quot;" width="576" height="732"></div>',
  '<div class="p0_1234" data-paragraph="6"><span>Between</span><img src="/myatriumhealth/Image/Load?fileName=22222222-aaaa-4bbb-8ccc-000000000002" width="164" height="39"></div>',
  '<script>alert("never")</script>',
  '<div class="p0_1234" data-paragraph="7"><span class="s0_1234">Line one<br>Line two</span></div>',
  '</div>',
].join('\n');

describe('messageHtmlToText', () => {
  const out = messageHtmlToText(epicBody);

  it('drops the inline <style> and any <script>', () => {
    expect(out.text).not.toMatch(/fmtConv|font-family|line-height|alert/);
  });

  it('puts each paragraph on its own line and decodes entities', () => {
    expect(out.text).toContain('Dear Sample Patient,\n');
    expect(out.text).toContain('Please read the steps & follow them.');
  });

  it('collapses runs of blank paragraphs to a single blank line', () => {
    expect(out.text).not.toMatch(/\n\n\n/);
    expect(out.text).toContain('Dear Sample Patient,\n\nPlease read');
  });

  it('turns list items into bulleted lines, keeping inline markup joined', () => {
    expect(out.text).toContain('- Step one\n- Step two');
  });

  it('turns <br> into a line break', () => {
    expect(out.text).toContain('Line one\nLine two');
  });

  it('replaces each inline image with a numbered placeholder', () => {
    expect(out.text).toContain('[image 1: fileName=11111111-aaaa-4bbb-8ccc-000000000001]');
    expect(out.text).toContain('Between [image 2: fileName=22222222-aaaa-4bbb-8ccc-000000000002]');
  });

  it('lists the images with their size and alt text', () => {
    expect(out.images).toEqual([
      {
        index: 1,
        fileName: '11111111-aaaa-4bbb-8ccc-000000000001',
        width: 576,
        height: 732,
        alt: 'Diagram "A"',
      },
      { index: 2, fileName: '22222222-aaaa-4bbb-8ccc-000000000002', width: 164, height: 39 },
    ]);
  });

  it('never follows an external image, and does not echo its URL', () => {
    const r = messageHtmlToText(
      '<p>Look</p><img src="https://tracker.example/pixel.gif?u=1" width="1" height="1">' +
        '<img src="data:image/png;base64,AAAA">',
    );
    expect(r.images).toEqual([
      { index: 1, rejected: 'not a portal image (tracker.example)', width: 1, height: 1 },
      { index: 2, rejected: 'not a portal image (data URI)' },
    ]);
    expect(r.text).toContain('[image 1: not fetched — not a portal image]');
    expect(r.text).not.toContain('tracker.example/pixel');
  });

  it('keeps a link target beside its text', () => {
    const r = messageHtmlToText('<p>See <a href="https://www.example.org/prep">the guide</a>.</p>');
    expect(r.text).toBe('See the guide (https://www.example.org/prep).');
  });

  it('returns empty text for an empty body', () => {
    expect(messageHtmlToText('')).toEqual({ text: '', images: [] });
  });
});
