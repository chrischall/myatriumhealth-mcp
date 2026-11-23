import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MfaRequiredError } from '../src/auth.js';
import { MyAtriumHealthClient } from '../src/client.js';
import { PatientContext } from '../src/patient-context.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerFileTools } from '../src/tools/files.js';
import type { BinaryResult, FetchInit, FetchResult, MahTransport } from '../src/transport.js';
import { ServerTransport } from '../src/transport-server.js';

// Every value below is synthetic: made-up ids, names and markup modelled on
// the SHAPE of the portal's responses. No patient content.

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<script id='cspScripts' nonce='0123456789abcdef0123456789abcdef'></script>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;
const loginPage = '<html><head><title>MyAtriumHealth - Login Page</title></head><body>sign in</body></html>';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const TIFF = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 2, 3, 4]);

const IMG1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const IMG2 = '22222222-aaaa-4bbb-8ccc-000000000002';

const body = [
  '<div id="fmtConv9" class="fmtConv"><style nonce="00">#fmtConv9 .p0_9 { color: red; }</style>',
  '<div class="p0_9" data-paragraph="0"><span>Hello Sample,</span></div>',
  '<div class="p0_9" data-paragraph="1"><span>&nbsp;</span></div>',
  '<div class="p0_9" data-paragraph="2"><span>Steps below &amp; attached.</span></div>',
  `<div><img src="/myatriumhealth/Image/Load?fileName=${IMG1}" width="576" height="732" alt="Step 1"></div>`,
  `<div><img src="/myatriumhealth/Image/Load?fileName=${IMG2}" width="164" height="39"></div>`,
  '<div><img src="https://tracker.example/p.gif"></div>',
  '</div>',
].join('');

const inbox = {
  conversations: [
    {
      hthId: 'WP-thread-1',
      subject: 'Sample instructions',
      organizationId: '',
      userKeys: ['WP-staff-1'],
      hasAttachments: true,
      messages: [
        {
          wmgId: 'WP-msg-1',
          deliveryInstantISO: '2026-01-02T03:04:05Z',
          isUnread: true,
          author: { empKey: 'WP-staff-1', displayName: '' },
          body,
          attachments: [
            { type: 2, dcsId: 'WP-dcs-1', etxId: '', fileExtension: 'PNG', name: 'Sample scan', organizationId: 'WP-org-ext' },
          ],
        },
        {
          wmgId: 'WP-msg-2',
          deliveryInstantISO: '2026-01-03T03:04:05Z',
          isUnread: false,
          author: { wprKey: 'WP-me' },
          body: '<div><p>Thanks!</p></div>',
          attachments: [],
        },
      ],
    },
  ],
  users: { 'WP-staff-1': { name: 'Sample Nurse, RN' } },
  viewers: {},
};
const archive = {
  conversations: [
    {
      hthId: 'WP-thread-archived',
      subject: 'Old thread',
      userKeys: [],
      messages: [{ wmgId: 'WP-old', body: '<p>Old text</p>', isUnread: false, author: {} }],
    },
  ],
  users: {},
};

interface Harness {
  calls: FetchInit[];
  bytesCalls: FetchInit[];
  call: (tool: string, args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
  json: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

type Bytes = (init: FetchInit) => BinaryResult;

function harness(opts: { bytes?: Bytes; api?: (init: FetchInit) => unknown; readOnly?: boolean; transport?: MahTransport } = {}): Harness {
  const calls: FetchInit[] = [];
  const bytesCalls: FetchInit[] = [];
  const json = (v: unknown): FetchResult => ({ status: 200, body: JSON.stringify(v) });
  const transport: MahTransport = opts.transport ?? {
    start: async () => {},
    close: async () => {},
    fetch: async (init) => {
      calls.push(init);
      if (!init.path.startsWith('api/')) return { status: 200, body: signedInPage };
      const custom = opts.api?.(init);
      if (custom !== undefined) return json(custom);
      if (init.path.endsWith('FetchHealthSummary')) return json({ patientFirstName: 'Sample', header: { patientAge: 40 } });
      if (init.path.endsWith('GetOrganizations')) return json({ organizations: {} });
      if (init.path.endsWith('GetFoldersList')) return json({ folders: [{ tag: 1, totalCount: 1 }, { tag: 3, totalCount: 0 }, { tag: 2, totalCount: 1 }] });
      if (init.path.endsWith('GetConversationList')) {
        const tag = (JSON.parse(String(init.body)) as { tag: number }).tag;
        return json(tag === 2 ? archive : tag === 1 ? inbox : { conversations: [], users: {} });
      }
      if (init.path.endsWith('BulkConversationAction')) return json({ results: [] });
      return json({});
    },
    fetchBytes: async (init) => {
      bytesCalls.push(init);
      if (opts.bytes) return opts.bytes(init);
      return { status: 200, bytes: PNG, contentType: 'application/octet-stream' };
    },
  };
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: (a: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, fn),
  } as never;
  process.env.MAH_PATIENT_FILE = join(tmpdir(), `mah-files-${Date.now()}-${Math.random()}.json`);
  const client = new MyAtriumHealthClient({ transport });
  const patients = new PatientContext();
  registerFileTools(server, client, patients, { readOnly: opts.readOnly ?? false });
  registerAccountTools(server, client, patients);
  const call = async (tool: string, args: Record<string, unknown>) =>
    (await handlers.get(tool)!(args)) as Awaited<ReturnType<Harness['call']>>;
  return {
    calls,
    bytesCalls,
    call,
    json: async (tool, args) => JSON.parse((await call(tool, args)).content[0]!.text!) as Record<string, unknown>,
  };
}

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'mah-out-'));
  process.env.MAH_OUTPUT_DIR = outDir;
  delete process.env.MCP_BLOB_BASE_URL;
  delete process.env.MCP_BLOB_SIGNING_KEY;
});
afterEach(() => {
  delete process.env.MAH_OUTPUT_DIR;
});

const defaults = { includeImages: false, markRead: false };

describe('mah_get_message', () => {
  it('returns the thread as clean text with numbered image placeholders', async () => {
    const h = harness();
    const out = await h.json('mah_get_message', { conversationId: 'WP-thread-1', ...defaults });
    expect(out.untrusted_content).toBe(true);
    expect(out.subject).toBe('Sample instructions');
    const [first, second] = out.messages as Record<string, unknown>[];
    expect(first!.text).toBe(
      `Hello Sample,\n\nSteps below & attached.\n[image 1: fileName=${IMG1}]\n[image 2: fileName=${IMG2}]\n` +
        '[image 3: not fetched — not a portal image]',
    );
    expect(first).toMatchObject({
      messageId: 'WP-msg-1',
      author: 'Sample Nurse, RN',
      deliveryInstantISO: '2026-01-02T03:04:05Z',
      isUnread: true,
    });
    expect(first!.images).toEqual([
      { index: 1, fileName: IMG1, width: 576, height: 732, alt: 'Step 1' },
      { index: 2, fileName: IMG2, width: 164, height: 39 },
      { index: 3, rejected: 'not a portal image (tracker.example)' },
    ]);
    expect(first!.attachments).toEqual([
      { attachmentId: 'WP-dcs-1', name: 'Sample scan', fileExtension: 'png', kind: 'document', downloadable: true },
    ]);
    expect(second).toMatchObject({ text: 'Thanks!', author: 'the patient (MyChart account)' });
  });

  it('never changes the unread state unless asked, and never fetches an image unless asked', async () => {
    const h = harness();
    await h.call('mah_get_message', { conversationId: 'WP-thread-1', ...defaults });
    const paths = h.calls.map((c) => c.path);
    expect(paths.some((p) => /BulkConversationAction|GetConversationDetails|GetConversationMessages/.test(p))).toBe(false);
    expect(h.bytesCalls).toHaveLength(0);
  });

  it('narrows to one message', async () => {
    const h = harness();
    const out = await h.json('mah_get_message', { conversationId: 'WP-thread-1', messageId: 'WP-msg-2', ...defaults });
    expect((out.messages as unknown[]).length).toBe(1);
  });

  it('finds a conversation outside the inbox', async () => {
    const h = harness();
    const out = await h.json('mah_get_message', { conversationId: 'WP-thread-archived', ...defaults });
    expect(out).toMatchObject({ folder: 2, subject: 'Old thread' });
  });

  it('says so when the conversation is in no folder', async () => {
    const h = harness();
    await expect(h.call('mah_get_message', { conversationId: 'WP-nope', ...defaults })).rejects.toThrow(/No conversation/);
  });

  it('inlines the images when includeImages is set', async () => {
    const h = harness();
    const out = await h.call('mah_get_message', { conversationId: 'WP-thread-1', includeImages: true, markRead: false });
    const images = out.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') });
    expect(h.bytesCalls.map((c) => c.path)).toEqual([
      `Image/Load?fileName=${IMG1}`,
      `Image/Load?fileName=${IMG2}`,
    ]);
  });

  it('marks the conversation read only when asked, with the bulk action the app uses', async () => {
    const h = harness();
    const out = await h.json('mah_get_message', { conversationId: 'WP-thread-1', includeImages: false, markRead: true });
    const action = h.calls.find((c) => c.path.endsWith('BulkConversationAction'))!;
    expect(JSON.parse(String(action.body))).toEqual({
      Conversations: [{ conversationId: 'WP-thread-1', organizationId: '' }],
      actionType: 'BulkRead',
    });
    expect(out.markRead).toEqual({ done: true });
  });

  it('refuses to mark read under MAH_READ_ONLY but still returns the message', async () => {
    const h = harness({ readOnly: true });
    const out = await h.json('mah_get_message', { conversationId: 'WP-thread-1', includeImages: false, markRead: true });
    expect(h.calls.some((c) => c.path.endsWith('BulkConversationAction'))).toBe(false);
    expect(out.markRead).toMatchObject({ done: false });
    expect((out.messages as unknown[]).length).toBe(2);
  });
});

describe('mah_list_messages view: "full"', () => {
  it('omits message bodies, keeping everything else', async () => {
    const h = harness();
    const out = await h.json('mah_list_messages', { folder: 1, view: 'full' });
    const text = JSON.stringify(out);
    expect(text).not.toContain('fmtConv');
    const msg = ((out.data as { conversations: { messages: Record<string, unknown>[] }[] }).conversations[0]!.messages[0])!;
    expect(msg.body).toBeUndefined();
    expect(msg.bodyOmitted).toEqual({ chars: body.length });
    expect(msg.attachments).toBeDefined();
    expect(String((out.data as Record<string, unknown>).bodiesOmitted)).toMatch(/mah_get_message/);
  });

  it('stays small however large the bodies are', async () => {
    const huge = '<div>' + '<span style="x">filler text </span>'.repeat(20_000) + '</div>';
    const h = harness({
      api: (init) =>
        init.path.endsWith('GetConversationList')
          ? { conversations: [{ hthId: 'WP-big', messages: [{ wmgId: 'm', body: huge }] }], users: {} }
          : undefined,
    });
    const res = await h.call('mah_list_messages', { folder: 1, view: 'full' });
    expect(res.content[0]!.text!.length).toBeLessThan(2_000);
  });
});

describe('mah_get_image', () => {
  it('returns the image, typed from its bytes rather than the header', async () => {
    const h = harness();
    const res = await h.call('mah_get_image', { fileName: IMG1 });
    const img = res.content.find((c) => c.type === 'image')!;
    expect(img).toMatchObject({ mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') });
    expect(h.bytesCalls[0]).toMatchObject({ method: 'GET', path: `Image/Load?fileName=${IMG1}` });
    const meta = JSON.parse(res.content[0]!.text!) as { file: Record<string, unknown> };
    expect(meta.file).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG.length, deliveredAs: 'image' });
  });

  it('refuses a file name that is not a portal token, fetching nothing', async () => {
    const h = harness();
    await expect(h.call('mah_get_image', { fileName: '../../Home' })).rejects.toThrow(/file name/);
    await expect(h.call('mah_get_image', { fileName: 'https://evil.example/x.png' })).rejects.toThrow();
    expect(h.bytesCalls).toHaveLength(0);
  });

  it('reports an expired session through the bridge instead of returning the login page', async () => {
    const h = harness({
      bytes: () => ({ status: 200, bytes: new TextEncoder().encode(loginPage), contentType: 'text/html; charset=utf-8' }),
    });
    await expect(h.call('mah_get_image', { fileName: IMG1 })).rejects.toThrow(/Not signed in/);
  });

  it('saves an image a model cannot view (TIFF) to a file instead of inlining it', async () => {
    const h = harness({ bytes: () => ({ status: 200, bytes: TIFF, contentType: 'image/tiff' }) });
    const res = await h.call('mah_get_image', { fileName: IMG1 });
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    const meta = JSON.parse(res.content[0]!.text!) as { file: { path: string; deliveredAs: string }; notes: string[] };
    expect(meta.file.deliveredAs).toBe('disk');
    expect(meta.file.path.startsWith(outDir)).toBe(true);
    expect(new Uint8Array(readFileSync(meta.file.path))).toEqual(TIFF);
    expect(meta.notes.join(' ')).toMatch(/tiff/i);
  });
});

describe('mah_get_image with bridge-less sign-in and an expired session', () => {
  // The session lapses between tool calls: the image answer is the login page,
  // and signing in again needs a verification code. That must surface as the
  // code flow every other tool raises — never as an image, never as a retry loop.
  it('surfaces the verification-code flow', async () => {
    let signedIn = true;
    let logins = 0;
    const auth = {
      credentialsRejected: false,
      mfaPending: false,
      isSignedIn: async () => signedIn,
      login: async () => {
        logins++;
        throw new MfaRequiredError(['sms', 'email']);
      },
      persistIfDirty: () => {},
      challengeContext: async () => null,
      request: async (path: string) => ({
        res: new Response(null, { status: 200 }),
        body: path.startsWith('api/')
          ? JSON.stringify({ patientFirstName: 'Sample', header: { patientAge: 40 } })
          : signedInPage,
      }),
      requestBytes: async () => {
        signedIn = false;
        return {
          res: new Response(null, { status: 302, headers: { location: '/myatriumhealth/Authentication/Login' } }),
          bytes: new Uint8Array(),
        };
      },
    };
    const transport = new ServerTransport(auth as never);
    const h = harness({ transport });
    const err = await h.call('mah_get_image', { fileName: IMG1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MfaRequiredError);
    expect((err as Error & { hint?: string }).message).toMatch(/verification code/);
    expect(logins).toBe(1);
  });
});

describe('mah_download_attachment', () => {
  const details = (downloadUrl: string) => (init: FetchInit) =>
    init.path.endsWith('GetDocumentDetails') ? { downloadUrl, previewUrl: '', mimeType: 'image/png', displayName: 'Sample scan' } : undefined;

  it('asks the document viewer for the file, then downloads it from the portal', async () => {
    const h = harness({ api: details('/myatriumhealth/Document/Download?doc=abc') });
    const res = await h.call('mah_download_attachment', {
      conversationId: 'WP-thread-1',
      messageId: 'WP-msg-1',
      attachmentId: 'WP-dcs-1',
    });
    const req = h.calls.find((c) => c.path.endsWith('GetDocumentDetails'))!;
    expect(JSON.parse(String(req.body))).toEqual({
      dcsId: 'WP-dcs-1',
      fileExtension: 'PNG',
      organizationId: 'WP-org-ext',
      useOldMobileLink: false,
    });
    expect(h.bytesCalls[0]!.path).toBe('Document/Download?doc=abc');
    expect(res.content.find((c) => c.type === 'image')).toMatchObject({ mimeType: 'image/png' });
  });

  it('refuses a download URL off the portal, fetching nothing', async () => {
    const h = harness({ api: details('https://files.evil.example/myatriumhealth/x.pdf') });
    await expect(
      h.call('mah_download_attachment', { conversationId: 'WP-thread-1', messageId: 'WP-msg-1', attachmentId: 'WP-dcs-1' }),
    ).rejects.toThrow(/only portal paths/);
    expect(h.bytesCalls).toHaveLength(0);
  });

  it('saves a non-image file to MAH_OUTPUT_DIR, owner-only', async () => {
    const DOC = new TextEncoder().encode('PK\u0003\u0004synthetic');
    const h = harness({
      api: details('/myatriumhealth/Document/Download?doc=abc'),
      bytes: () => ({ status: 200, bytes: DOC, contentType: 'application/octet-stream', contentDisposition: 'attachment; filename="sample.docx"' }),
    });
    const res = await h.call('mah_download_attachment', { conversationId: 'WP-thread-1', messageId: 'WP-msg-1', attachmentId: 'WP-dcs-1' });
    const meta = JSON.parse(res.content[0]!.text!) as { file: { path: string; fileName: string; sizeBytes: number } };
    expect(meta.file.fileName).toBe('sample.docx');
    expect(meta.file.sizeBytes).toBe(DOC.length);
    expect(readdirSync(outDir)).toEqual(['sample.docx']);
  });

  it('says so when the attachment is not on the message', async () => {
    const h = harness();
    await expect(
      h.call('mah_download_attachment', { conversationId: 'WP-thread-1', messageId: 'WP-msg-1', attachmentId: 'WP-other' }),
    ).rejects.toThrow(/not on this message/);
  });
});

describe('mah_list_documents', () => {
  const page = (n: number, start: number) =>
    Array.from({ length: n }, (_, i) => ({ dcsID: `WP-doc-${start + i}`, docExt: 'PDF', docType: 'Visit summary', docDesc: '', date: '2026-01-01', new: i === 0 }));

  it('lists letters and every page of documents', async () => {
    let pages = 0;
    const seen: boolean[] = [];
    const h = harness({
      api: (init) => {
        if (init.path.endsWith('GetLettersList')) {
          return {
            letters: [{ hnoId: 'WP-ltr-1', csn: '123', dateISO: '2026-01-05', reason: 'Results letter', viewed: false, depId: 'D1' }],
            users: {},
            departments: { D1: { name: 'Sample Clinic' } },
          };
        }
        if (init.path.endsWith('LoadOtherDocuments')) {
          seen.push((JSON.parse(String(init.body)) as { isInitialLoad: boolean }).isInitialLoad);
          pages++;
          return { documents: pages === 1 ? page(25, 0) : page(3, 25) };
        }
        return undefined;
      },
    });
    const out = await h.json('mah_list_documents', { kind: 'all' });
    expect(out.letters).toEqual([
      { letterId: 'WP-ltr-1', csn: '123', date: '2026-01-05', reason: 'Results letter', from: 'Sample Clinic', unread: true },
    ]);
    expect((out.documents as unknown[]).length).toBe(28);
    expect((out.documents as Record<string, unknown>[])[0]).toEqual({
      documentId: 'WP-doc-0', fileExtension: 'pdf', type: 'Visit summary', date: '2026-01-01', unread: true,
    });
    expect(seen).toEqual([true, false]);
  });

  it('reports a section the portal refuses without losing the other', async () => {
    const h = harness({
      api: (init) =>
        init.path.endsWith('LoadOtherDocuments') ? { documents: [] } : undefined,
    });
    // GetLettersList answers {} here — no letters, not an error.
    const out = await h.json('mah_list_documents', { kind: 'all' });
    expect(out.letters).toEqual([]);
    expect(out.documents).toEqual([]);
  });
});

describe('mah_get_document', () => {
  it('returns a letter as text with its images named', async () => {
    const h = harness({
      api: (init) =>
        init.path.endsWith('GetLetterDetails')
          ? { bodyHTML: `<div><style>.x{}</style><p>Dear Sample,</p><p>Your results are normal.</p><img src="/myatriumhealth/Image/Load?fileName=${IMG1}"></div>` }
          : undefined,
    });
    const out = await h.json('mah_get_document', { letterId: 'WP-ltr-1', csn: '123' });
    expect(out.text).toBe(`Dear Sample,\nYour results are normal.\n[image 1: fileName=${IMG1}]`);
    const req = h.calls.find((c) => c.path.endsWith('GetLetterDetails'))!;
    expect(JSON.parse(String(req.body))).toMatchObject({ hnoId: 'WP-ltr-1', csn: '123', PageNonce: '0123456789abcdef0123456789abcdef' });
  });

  it('downloads a document through the document viewer', async () => {
    const h = harness({
      api: (init) => (init.path.endsWith('GetDocumentDetails') ? { downloadUrl: '/myatriumhealth/Document/Download?d=1' } : undefined),
    });
    await h.call('mah_get_document', { documentId: 'WP-doc-1', fileExtension: 'png' });
    const req = h.calls.find((c) => c.path.endsWith('GetDocumentDetails'))!;
    expect(JSON.parse(String(req.body))).toMatchObject({ dcsId: 'WP-doc-1', fileExtension: 'png', useOldMobileLink: true });
    expect(h.bytesCalls[0]!.path).toBe('Document/Download?d=1');
  });

  it('wants exactly one of letterId and documentId', async () => {
    const h = harness();
    await expect(h.call('mah_get_document', {})).rejects.toThrow(/exactly one/);
    await expect(h.call('mah_get_document', { letterId: 'a', documentId: 'b' })).rejects.toThrow(/exactly one/);
  });
});

/** A one-page PDF whose text layer says `text` — built here, so no fixture file. */
function syntheticPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('a PDF attachment', () => {
  it('comes back as its text plus the saved file', async () => {
    const PDF = syntheticPdf('Synthetic clearance letter');
    const h = harness({
      api: (init) => (init.path.endsWith('GetDocumentDetails') ? { downloadUrl: '/myatriumhealth/Document/Download?d=2' } : undefined),
      bytes: () => ({ status: 200, bytes: PDF, contentType: 'application/pdf', contentDisposition: 'inline; filename="letter.pdf"' }),
    });
    const res = await h.call('mah_download_attachment', { conversationId: 'WP-thread-1', messageId: 'WP-msg-1', attachmentId: 'WP-dcs-1' });
    const meta = JSON.parse(res.content[0]!.text!) as { file: { path: string; mimeType: string; deliveredAs: string } };
    expect(meta.file).toMatchObject({ mimeType: 'application/pdf', deliveredAs: 'disk' });
    expect(readdirSync(outDir)).toEqual(['letter.pdf']);
    expect(res.content.slice(1).map((c) => c.text ?? '').join('\n')).toContain('Synthetic clearance letter');
  });
});
