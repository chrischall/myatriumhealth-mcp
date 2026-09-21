import { beforeEach, describe, expect, it } from 'vitest';
import { MyAtriumHealthClient } from '../src/client.js';
import type { FetchInit, FetchResult, MahTransport } from '../src/transport.js';
import { PatientContext } from '../src/patient-context.js';
import { registerMessageTools } from '../src/tools/messages.js';

// Every shape below is taken from a live capture of the MyChart web app
// replying to a thread (2026-09-21, docs/MYATRIUMHEALTH-API.md, "Replying to a
// conversation"). The ids are invented; their lengths and roles are not.
const HTH = 'WP-24thread';
const SELF = 'WP-24selfviewer';
const DOC = 'WP-24document';
const COMPOSE = 'WP-24compose';
const NEW_WMG = 'WP-24newmessage';

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<script id='cspScripts' nonce='0123456789abcdef0123456789abcdef'></script>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;

const composeSettings = {
  maxSubjectLength: 254,
  maxMessageLength: 500,
  attachmentSettings: {
    canAttach: true,
    maxNumberOfAttachments: 3,
    docAndImageSettings: {
      maxFileSize: 10240,
      allowedFileExtensions: ['BMP', 'DOC', 'DOCX', 'JPEG', 'JPG', 'PDF', 'PNG', 'TIF', 'TIFF'],
    },
    videoSettings: {
      maxFileSize: 65536,
      allowedFileExtensions: ['3GP', '3GPP', 'AVI', 'MOV', 'MP4', 'MPEG', 'MPG', 'WMV'],
    },
  },
  isConfidentialMessagingOn: true,
  isUnicodeMessagingOn: true,
  showIndividualViewers: true,
};

/** The stored body is HTML: one `data-paragraph` div per line that was sent. */
const storedBody = (lines: string[]): string =>
  `<div id="x" class="fmtConv"><style nonce="n">.p0_1{}</style>` +
  lines.map((l, i) => `<div class="p0_1" data-paragraph="${i}"><span class="s0_1">${l.replace(/'/g, '&#39;')}</span></div>`).join('') +
  `</div>`;

const oldMessage = {
  wmgId: 'WP-24old',
  isUnread: false,
  deliveryInstantISO: '2026-08-26T12:17:41Z',
  body: storedBody(['Script sent to Harris Teeter']),
  author: { displayName: '', wprKey: '' , empKey: 'WP-24provider' },
  attachments: [],
  tasks: [],
  suggestedActions: [],
};

function details(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    hthId: HTH,
    subject: 'Zepbound refill',
    organizationId: '',
    replyFlags: { canReply: true, cannotReplyReason: 0 },
    viewers: { [SELF]: { wprId: SELF, name: 'Christopher', isSelf: true, isShown: false, isSelected: false, organizationId: '' } },
    viewerKeys: [SELF],
    userKeys: ['WP-24provider', 'ser_WP-24nurse'],
    users: {
      'WP-24provider': { name: 'Vibhu Dhingra, MD' },
      'ser_WP-24nurse': { name: 'Jade W, RN' },
    },
    messages,
    ...overrides,
  };
}

interface Portal {
  calls: FetchInit[];
  transport: MahTransport;
  /** Hook run when a given endpoint is hit, before it answers. */
  on: Record<string, () => void>;
  sent: boolean;
}

function portal(opts: {
  details?: Record<string, unknown>;
  composeSettings?: Record<string, unknown>;
  sendReplyAnswer?: string;
  saveDraftAnswer?: string;
  newBodyLines?: string[];
} = {}): Portal {
  const p: Portal = { calls: [], on: {}, sent: false, transport: undefined as never };
  const json = (v: unknown): FetchResult => ({ status: 200, body: JSON.stringify(v) });
  p.transport = {
    start: async () => {},
    close: async () => {},
    fetch: async (init) => {
      p.calls.push(init);
      const path = init.path.split('?')[0] as string;
      const hook = Object.entries(p.on).find(([k]) => path.endsWith(k));
      hook?.[1]();
      if (!path.startsWith('api/') && !path.startsWith('DocumentUpload/')) return { status: 200, body: signedInPage };
      if (path.endsWith('health-summary/FetchHealthSummary')) {
        return json({ patientFirstName: 'Christopher', header: { patientAge: 45 } });
      }
      if (path.endsWith('GetConversationDetails')) {
        const sent = p.sent
          ? [{ ...oldMessage, wmgId: NEW_WMG, deliveryInstantISO: '2026-09-21T18:08:32Z', author: { displayName: '', wprKey: SELF }, body: storedBody(opts.newBodyLines ?? ["I'd like another refill at the same dosage."]) }]
          : [];
        return json(details([oldMessage, ...sent], opts.details));
      }
      if (path.endsWith('GetComposeSettings')) return json(opts.composeSettings ?? composeSettings);
      if (path.endsWith('GetComposeId')) return json(COMPOSE);
      if (path.endsWith('SaveReplyDraft')) return { status: 200, body: opts.saveDraftAnswer ?? JSON.stringify({ conversationId: HTH, error: 0 }) };
      if (path.endsWith('SendReply')) {
        p.sent = true;
        return { status: 200, body: opts.sendReplyAnswer ?? JSON.stringify(HTH) };
      }
      if (path.endsWith('RemoveComposeId')) return { status: 200, body: '""' };
      if (path.endsWith('DocumentUpload/UploadFile')) {
        return json({ Success: true, Data: [{ DocumentId: DOC, FileDisplayName: 'scan.png', FileExtension: '.png', FileReference: 'WP-24ref', DownloadUrl: null, Page: null, AllowPreview: true, ContextData: null }] });
      }
      if (path.endsWith('DocumentUpload/DeleteFile')) return json({ Success: true });
      return { status: 500, body: '<title>Oops!</title>' };
    },
  };
  return p;
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function tool(p: Portal, opts: { readOnly?: boolean; attachmentsSupported?: boolean } = {}) {
  const handlers = new Map<string, { def: { description: string; annotations?: Record<string, unknown> }; fn: Handler }>();
  const server = {
    registerTool: (name: string, def: never, fn: Handler) => handlers.set(name, { def, fn }),
  } as never;
  const client = new MyAtriumHealthClient({ transport: p.transport });
  const patients = new PatientContext();
  registerMessageTools(server, client, patients, {
    readOnly: opts.readOnly ?? false,
    attachmentsSupported: opts.attachmentsSupported ?? true,
  });
  const h = handlers.get('mah_reply_message')!;
  return {
    def: h.def,
    patients,
    call: async (args: Record<string, unknown>) => {
      const r = await h.fn({ view: undefined, ...args });
      return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    },
  };
}

const endpoints = (p: Portal): string[] => p.calls.map((c) => c.path.split('?')[0]!.replace(/^api\//, ''));
const mutating = /SaveReplyDraft|SendReply|GetComposeId|UploadFile|DeleteFile|RemoveComposeId/;
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

beforeEach(() => {
  // The account holder: no stored patient selection.
  process.env.MAH_PATIENT_FILE = `/tmp/mah-reply-${Date.now()}-${Math.random()}.json`;
});

describe('mah_reply_message — the preview', () => {
  it('is the default, and touches nothing that sends', async () => {
    const p = portal();
    const out = await tool(p).call({ conversationId: HTH, body: 'Hello there' });
    expect(out.sent).toBe(false);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
    expect(out).toMatchObject({
      patient: 'Christopher',
      conversationId: HTH,
      subject: 'Zepbound refill',
      recipients: ['Vibhu Dhingra, MD', 'Jade W, RN'],
      body: 'Hello there',
    });
    expect(String(out.nextStep)).toMatch(/confirm: ?true/);
  });

  it('refuses a thread the portal will not accept a reply on', async () => {
    const p = portal({ details: { replyFlags: { canReply: false, cannotReplyReason: 3 } } });
    await expect(tool(p).call({ conversationId: HTH, body: 'x', confirm: true })).rejects.toThrow(/cannot be replied to/i);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses a body longer than the portal allows, before anything is sent', async () => {
    const p = portal();
    await expect(tool(p).call({ conversationId: HTH, body: 'x'.repeat(501), confirm: true })).rejects.toThrow(/500/);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  // A limit missing from GetComposeSettings is an unreadable answer, not a
  // portal limit of zero — reporting "allows 0" sends people after the wrong cause.
  it('says the limits could not be read when GetComposeSettings omits them', async () => {
    const p = portal({ composeSettings: { attachmentSettings: composeSettings.attachmentSettings } });
    const err = await tool(p).call({ conversationId: HTH, body: 'x' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not report/i);
    expect((err as Error).message).not.toMatch(/allows 0/);
  });

  it('says the attachment limits could not be read when they are missing', async () => {
    const { maxNumberOfAttachments: _drop, ...rest } = composeSettings.attachmentSettings;
    const p = portal({ composeSettings: { ...composeSettings, attachmentSettings: rest } });
    const err = await tool(p)
      .call({ conversationId: HTH, body: 'x', attachments: [{ filename: 'a.pdf', contentBase64: png }] })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not report/i);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses when the reply cannot be attributed to exactly one viewer', async () => {
    const p = portal({ details: { viewers: {} } });
    await expect(tool(p).call({ conversationId: HTH, body: 'x', confirm: true })).rejects.toThrow(/viewer/i);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });
});

describe('mah_reply_message — sending', () => {
  it('replays the web app\'s own sequence and request body', async () => {
    const p = portal();
    await tool(p).call({ conversationId: HTH, body: "I'd like another refill at the same dosage.", confirm: true });
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([
      'conversations/GetComposeId',
      'conversations/SaveReplyDraft',
      'conversations/SendReply',
      'conversations/RemoveComposeId',
    ]);
    const send = p.calls.find((c) => c.path.endsWith('SendReply'))!;
    expect(JSON.parse(send.body as string)).toEqual({
      conversationId: HTH,
      organizationId: '',
      viewers: [{ wprId: SELF }],
      messageBody: ["I'd like another refill at the same dosage."],
      documentIds: [],
      includeOtherViewers: false,
      composeId: COMPOSE,
    });
    const draft = p.calls.find((c) => c.path.endsWith('SaveReplyDraft'))!;
    expect(draft.body).toBe(send.body);
  });

  it('sends one paragraph per line, splitting exactly as the composer does', async () => {
    const p = portal({ newBodyLines: ['one', '', 'two', 'three'] });
    await tool(p).call({ conversationId: HTH, body: 'one\r\n\ntwo\rthree', confirm: true });
    const send = JSON.parse(p.calls.find((c) => c.path.endsWith('SendReply'))!.body as string);
    expect(send.messageBody).toEqual(['one', '', 'two', 'three']);
  });

  it('returns the new message in the shape mah_list_messages reports', async () => {
    const p = portal();
    const out = await tool(p).call({ conversationId: HTH, body: "I'd like another refill at the same dosage.", confirm: true });
    expect(out).toMatchObject({
      sent: true,
      verified: true,
      patient: 'Christopher',
      conversationId: HTH,
      message: { wmgId: NEW_WMG, deliveryInstantISO: '2026-09-21T18:08:32Z', attachments: [] },
    });
  });

  it('says so when the sent message cannot be found afterwards, rather than inventing one', async () => {
    const p = portal({ newBodyLines: ['something else entirely'] });
    const out = await tool(p).call({ conversationId: HTH, body: 'what I sent', confirm: true });
    expect(out.sent).toBe(true);
    expect(out.verified).toBe(false);
    expect(out.message).toBeUndefined();
  });

  it('reports an unconfirmed send as UNCERTAIN, never as a failure safe to retry', async () => {
    // No thread-id echo AND the message cannot be read back.
    const p = portal({ sendReplyAnswer: '""', newBodyLines: ['something else entirely'] });
    await expect(tool(p).call({ conversationId: HTH, body: 'x', confirm: true })).rejects.toThrow(
      /may have been sent|before retrying/i,
    );
    expect(endpoints(p).filter((e) => e.endsWith('SendReply'))).toHaveLength(1);
  });

  // The app accepts any non-empty answer. An answer that is not the thread id
  // is not proof of failure, so the thread is read back before deciding.
  it('confirms a send by reading the thread back when the answer is not the thread id', async () => {
    const p = portal({ sendReplyAnswer: JSON.stringify('WP-24somethingelse') });
    const out = await tool(p).call({ conversationId: HTH, body: "I'd like another refill at the same dosage.", confirm: true });
    expect(out).toMatchObject({ sent: true, verified: true, message: { wmgId: NEW_WMG } });
  });

  // A sign-in page in answer to the send proves it was not accepted: clean up
  // and say so, rather than "may have been sent".
  it('treats a sign-in page in answer to the send as not sent, and cleans up', async () => {
    const p = portal({
      sendReplyAnswer: '<html><head><title>MyAtriumHealth - Login Page</title></head></html>',
    });
    const err = await tool(p)
      .call({ conversationId: HTH, body: 'x', attachments: [{ filename: 'scan.png', contentBase64: png }], confirm: true })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not signed in/i);
    expect((err as Error).message).not.toMatch(/may have been sent/i);
    expect(endpoints(p).filter((e) => /DeleteFile|RemoveComposeId/.test(e))).toEqual([
      'DocumentUpload/DeleteFile',
      'conversations/RemoveComposeId',
    ]);
  });

  it('never sends if the session re-authenticated after the patient was confirmed', async () => {
    const p = portal();
    const t = tool(p);
    // A re-sign-in mid-flow returns the portal to the account holder; the
    // reply must not go out under whoever the portal is serving now.
    p.on['GetComposeId'] = () => t.patients.invalidate();
    await expect(t.call({ conversationId: HTH, body: 'x', confirm: true })).rejects.toThrow(/re-authenticated|nothing was sent/i);
    expect(endpoints(p).filter((e) => /SaveReplyDraft|SendReply/.test(e))).toEqual([]);
  });

  it('marks the send so the transport will not sign in again and replay it', async () => {
    const p = portal();
    await tool(p).call({ conversationId: HTH, body: 'x', confirm: true });
    expect(p.calls.find((c) => c.path.endsWith('SendReply'))!.replay).toBe(false);
  });
});

describe('mah_reply_message — the read-only gate', () => {
  it('refuses to send, and sends nothing', async () => {
    const p = portal();
    await expect(tool(p, { readOnly: true }).call({ conversationId: HTH, body: 'x', confirm: true })).rejects.toThrow(
      /MAH_READ_ONLY/,
    );
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('still previews, and says the send would be refused', async () => {
    const p = portal();
    const out = await tool(p, { readOnly: true }).call({ conversationId: HTH, body: 'x' });
    expect(out.sent).toBe(false);
    expect(String(out.sendBlocked)).toMatch(/MAH_READ_ONLY/);
  });
});

describe('mah_reply_message — attachments', () => {
  it('uploads each file the way the composer does and attaches its DocumentId', async () => {
    const p = portal();
    await tool(p).call({
      conversationId: HTH,
      body: 'see attached',
      attachments: [{ filename: 'scan.png', contentBase64: png }],
      confirm: true,
    });
    const up = p.calls.find((c) => c.path === 'DocumentUpload/UploadFile')!;
    expect(up.body).toBeInstanceOf(FormData);
    const form = up.body as FormData;
    const file = form.get('__file__[]') as File;
    expect(file.name).toBe('scan.png');
    expect(file.type).toBe('image/png');
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== '__file__[]'))).toEqual({
      AddDCSToCache: 'true',
      IsPending: 'true',
      DCSSource: '820',
      OrganizationId: '',
      EncryptDCSOnRemote: '',
      __RequestVerificationToken: 'a'.repeat(172),
    });
    const send = JSON.parse(p.calls.find((c) => c.path.endsWith('SendReply'))!.body as string);
    expect(send.documentIds).toEqual([DOC]);
  });

  it('refuses attachments through the browser bridge before uploading anything', async () => {
    const p = portal();
    await expect(
      tool(p, { attachmentsSupported: false }).call({
        conversationId: HTH,
        body: 'x',
        attachments: [{ filename: 'scan.png', contentBase64: png }],
        confirm: true,
      }),
    ).rejects.toThrow(/bridge/i);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses a file type the portal does not accept', async () => {
    const p = portal();
    await expect(
      tool(p).call({ conversationId: HTH, body: 'x', attachments: [{ filename: 'run.exe', contentBase64: png }], confirm: true }),
    ).rejects.toThrow(/EXE/i);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses more files than the portal allows', async () => {
    const p = portal();
    const f = { filename: 'a.pdf', contentBase64: png };
    await expect(
      tool(p).call({ conversationId: HTH, body: 'x', attachments: [f, f, f, f], confirm: true }),
    ).rejects.toThrow(/3/);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses a file over the size limit', async () => {
    const p = portal();
    const big = Buffer.alloc(10240 * 1024 + 1).toString('base64');
    await expect(
      tool(p).call({ conversationId: HTH, body: 'x', attachments: [{ filename: 'a.pdf', contentBase64: big }], confirm: true }),
    ).rejects.toThrow(/too large|limit/i);
  });

  it('deletes what it uploaded when the reply fails before being sent', async () => {
    const p = portal({ saveDraftAnswer: '<title>Oops!</title>' });
    await expect(
      tool(p).call({ conversationId: HTH, body: 'x', attachments: [{ filename: 'scan.png', contentBase64: png }], confirm: true }),
    ).rejects.toThrow();
    const del = p.calls.find((c) => c.path === 'DocumentUpload/DeleteFile');
    expect(JSON.parse(del!.body as string)).toMatchObject({ DocumentId: DOC, FileExtension: 'png' });
    expect(endpoints(p).filter((e) => e.endsWith('SendReply'))).toEqual([]);
  });
});

describe('mah_reply_message — the tool surface', () => {
  it('is annotated destructive and names what is irreversible', () => {
    const { def } = tool(portal());
    expect(def.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(def.description).toMatch(/irreversible/i);
    expect(def.description).toMatch(/confirm/i);
  });
});
