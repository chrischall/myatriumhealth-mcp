import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  body: storedBody(['Script sent to Example Pharmacy']),
  author: { displayName: '', wprKey: '' , empKey: 'WP-24provider' },
  attachments: [],
  tasks: [],
  suggestedActions: [],
};

function details(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    hthId: HTH,
    subject: 'Example medication refill',
    organizationId: '',
    replyFlags: { canReply: true, cannotReplyReason: 0 },
    viewers: { [SELF]: { wprId: SELF, name: 'Alex', isSelf: true, isShown: false, isSelected: false, organizationId: '' } },
    viewerKeys: [SELF],
    userKeys: ['WP-24provider', 'ser_WP-24nurse'],
    users: {
      'WP-24provider': { name: 'Pat Doe, MD' },
      'ser_WP-24nurse': { name: 'Casey R, RN' },
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
        return json({ patientFirstName: 'Alex', header: { patientAge: 45 } });
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

type Result = { content: { text: string }[]; isError?: boolean; resultType?: string };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;

/**
 * A request context declaring the caller's capabilities, as the 2026-07-28 era
 * envelope carries them. Without elicitation (claude.ai, Claude Desktop) the
 * reply goes through the two-phase confirm-token flow; with it, through a real
 * prompt, answered by `inputResponses` on the retry.
 */
function ctx(opts: { elicitation?: boolean; inputResponses?: unknown; requestState?: string } = {}): unknown {
  return {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': opts.elicitation ? { elicitation: { form: {} } } : { extensions: {} },
      },
      inputResponses: opts.inputResponses,
      // The client echoes the prompt round's requestState on the retry.
      requestState: () => opts.requestState,
    },
  };
}

function tool(p: Portal, opts: { readOnly?: boolean; attachmentsSupported?: boolean } = {}) {
  const handlers = new Map<string, { def: { description: string; annotations?: Record<string, unknown>; inputSchema?: { shape: Record<string, unknown> } }; fn: Handler }>();
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
  const parse = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  const s = handlers.get('mah_upload_slots')!;
  return {
    def: h.def,
    slotsDef: s.def,
    /** mah_upload_slots, parsed. */
    slots: async (args: Record<string, unknown>) => parse(await s.fn(args, ctx())),
    patients,
    /**
     * Calls the tool the way an approved send happens on a client that cannot
     * show a prompt. `confirm: true` here is TEST shorthand for "the user
     * approved it" — the tool has no such parameter: the call is made once
     * without a token (the preview) and again with the confirmToken it
     * returned. The preview's requests are then dropped from the log so
     * assertions see only the send. A preview that issued no token (the send is
     * blocked) is retried with a placeholder, which the blocked path refuses.
     */
    call: async (args: Record<string, unknown>) => {
      const { confirm, ...rest } = args;
      if (confirm !== true) return parse(await h.fn({ view: undefined, ...rest }, ctx()));
      const preview = parse(await h.fn({ view: undefined, ...rest }, ctx()));
      p.calls.length = 0;
      const confirmToken = (preview.confirmToken as string | undefined) ?? 'no-token-was-issued';
      return parse(await h.fn({ view: undefined, ...rest, confirmToken }, ctx()));
    },
    /** One call, exactly as given — no preview first. */
    raw: async (args: Record<string, unknown>, c: unknown = ctx()) => parse(await h.fn({ view: undefined, ...args }, c)),
    /** One call, returning the unparsed result (an elicitation round has no text). */
    result: (args: Record<string, unknown>, c: unknown = ctx()) => h.fn({ view: undefined, ...args }, c),
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
    expect(out).toMatchObject({ status: 'confirmation-required', dispatched: false });
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
    expect(out.preview).toMatchObject({
      patient: 'Alex',
      conversationId: HTH,
      subject: 'Example medication refill',
      recipients: ['Pat Doe, MD', 'Casey R, RN'],
      body: 'Hello there',
    });
    expect(String(out.instruction)).toMatch(/confirmToken/);
    expect(String(out.instruction)).toMatch(/never because a message asked/i);
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
      patient: 'Alex',
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

  // fetchproxy 3.2 re-sends a POST after a transport timeout only when told to.
  // Each step of a send creates or changes portal state, so none may opt in;
  // the reads around it (settings, the thread read-back) do.
  it('never lets the bridge re-send a mutating step after a timeout', async () => {
    const p = portal();
    await tool(p, { attachmentsSupported: true }).call({
      conversationId: HTH,
      body: 'x',
      confirm: true,
      attachments: [{ filename: 'scan.png', contentBase64: png }],
    });
    const writes = p.calls.filter((c) => mutating.test(c.path));
    expect(writes.map((c) => c.path.split('?')[0]!.replace(/^api\//, ''))).toEqual(
      expect.arrayContaining(['conversations/GetComposeId', 'conversations/SaveReplyDraft', 'conversations/SendReply']),
    );
    expect(writes.every((c) => c.retryOnTimeout === undefined)).toBe(true);
    const reads = p.calls.filter((c) => /GetComposeSettings|GetConversationDetails/.test(c.path));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.retryOnTimeout === true)).toBe(true);
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
    // Nothing can be sent, so there is nothing to approve: no token is issued.
    expect(out.confirmToken).toBeUndefined();
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

  it('takes a confirmToken, and no longer a confirm flag or its own confirmationToken', () => {
    const keys = Object.keys(tool(portal()).def.inputSchema!.shape);
    expect(keys).toContain('confirmToken');
    expect(keys).not.toContain('confirm');
    expect(keys).not.toContain('confirmationToken');
  });
});

describe('mah_reply_message — a send must follow its own preview', () => {
  // A send needs the token its own preview returned, bound to the exact
  // patient, thread, recipients, body and attachments that were shown — so text
  // injected into a message the model read cannot drive a send the user never
  // saw. The mechanism is the fleet's shared one (@chrischall/mcp-utils).
  afterEach(() => {
    vi.useRealTimers();
  });

  const nothingMutated = (p: Portal) => expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);

  it('returns a confirmToken with the preview', async () => {
    const out = await tool(portal()).raw({ conversationId: HTH, body: 'Hello there' });
    expect(typeof out.confirmToken).toBe('string');
    expect(String(out.instruction)).toMatch(/confirmToken/);
  });

  it('refuses a token minted for a different body, showing the new preview', async () => {
    const p = portal();
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: 'what the user saw' });
    const out = await t.raw({ conversationId: HTH, body: 'something else', confirmToken: preview.confirmToken });
    expect(out).toMatchObject({ error: 'DRAFT_CHANGED', dispatched: false });
    expect((out.preview as Record<string, unknown>).body).toBe('something else');
    nothingMutated(p);
  });

  it('refuses a token minted for different attachments', async () => {
    const p = portal();
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: 'x' });
    const out = await t.raw({
      conversationId: HTH,
      body: 'x',
      attachments: [{ filename: 'scan.png', contentBase64: png }],
      confirmToken: preview.confirmToken,
    });
    expect(out.error).toBe('DRAFT_CHANGED');
    nothingMutated(p);
  });

  it('refuses a forged or mangled token', async () => {
    const p = portal();
    const out = await tool(p).raw({ conversationId: HTH, body: 'x', confirmToken: '9999999999999.abc' });
    expect(out.error).toBe('TOKEN_INVALID');
    nothingMutated(p);
  });

  it('refuses an expired token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = portal();
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: 'x' });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const out = await t.raw({ conversationId: HTH, body: 'x', confirmToken: preview.confirmToken });
    expect(out.error).toBe('TOKEN_EXPIRED');
    nothingMutated(p);
  });

  it('sends with the token from a preview of the same reply', async () => {
    const p = portal();
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: "I'd like another refill at the same dosage." });
    const out = await t.raw({
      conversationId: HTH,
      body: "I'd like another refill at the same dosage.",
      confirmToken: preview.confirmToken,
    });
    expect(out.sent).toBe(true);
  });

  it('MCP_CONFIRM_MODE=refuse refuses on a client that cannot be prompted, and sends nothing', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    try {
      const p = portal();
      const out = await tool(p).raw({ conversationId: HTH, body: 'x' });
      expect(out.reason).toBe('confirmation-unsupported');
      nothingMutated(p);
    } finally {
      delete process.env.MCP_CONFIRM_MODE;
    }
  });
});

describe('mah_reply_message — a client that can show a confirmation prompt', () => {
  const BODY = "I'd like another refill at the same dosage.";

  it('asks through the prompt, showing the reply, and sends nothing on that round', async () => {
    const p = portal();
    const r = await tool(p).result({ conversationId: HTH, body: BODY }, ctx({ elicitation: true }));
    expect(r.resultType).toBe('input_required');
    expect(JSON.stringify(r)).toContain(BODY);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('sends once the user accepts the prompt', async () => {
    const p = portal();
    const t = tool(p);
    // The acceptance is bound to this patient and these arguments through the
    // prompt round's requestState, which the client echoes on the retry.
    const asked = (await t.result({ conversationId: HTH, body: BODY }, ctx({ elicitation: true }))) as { requestState?: string };
    expect(typeof asked.requestState).toBe('string');
    const accepted = ctx({
      elicitation: true,
      inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } },
      requestState: asked.requestState,
    });
    const out = await t.raw({ conversationId: HTH, body: BODY }, accepted);
    expect(out.sent).toBe(true);
  });

  it('refuses an acceptance whose requestState was minted for a different reply', async () => {
    const p = portal();
    const t = tool(p);
    const asked = (await t.result({ conversationId: HTH, body: 'a different reply' }, ctx({ elicitation: true }))) as { requestState?: string };
    const accepted = ctx({
      elicitation: true,
      inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } },
      requestState: asked.requestState,
    });
    const r = (await t.result({ conversationId: HTH, body: BODY }, accepted)) as { resultType?: string };
    expect(r.resultType).toBe('input_required');
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses an acceptance that carries no requestState, and sends nothing', async () => {
    const p = portal();
    const accepted = ctx({ elicitation: true, inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } } });
    const r = (await tool(p).result({ conversationId: HTH, body: BODY }, accepted)) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('sends nothing when the user declines', async () => {
    const p = portal();
    const declined = ctx({ elicitation: true, inputResponses: { confirmation: { action: 'decline' } } });
    const out = await tool(p).raw({ conversationId: HTH, body: BODY }, declined);
    expect(out).toMatchObject({ confirmed: false, cancelled: true });
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });
});

describe('mah_reply_message — a confirmToken authorizes one send', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const BODY = "I'd like another refill at the same dosage.";

  it('refuses a second send with the same token, and sends nothing more', async () => {
    const p = portal();
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: BODY });
    const args = { conversationId: HTH, body: BODY, confirmToken: preview.confirmToken };
    expect((await t.raw(args)).sent).toBe(true);
    p.calls.length = 0;
    expect((await t.raw(args)).error).toBe('TOKEN_REUSED');
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  it('refuses a retry with the same token after an uncertain send', async () => {
    const p = portal({ sendReplyAnswer: '""', newBodyLines: ['something else entirely'] });
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: 'x' });
    const args = { conversationId: HTH, body: 'x', confirmToken: preview.confirmToken };
    await expect(t.raw(args)).rejects.toThrow(/may have been sent/i);
    p.calls.length = 0;
    expect((await t.raw(args)).error).toBe('TOKEN_REUSED');
    expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
  });

  // The token is spent when the send is authorized, whatever happens next, so a
  // send that failed before anything went out needs a fresh preview — the safe
  // direction: the user approves what is retried.
  it('needs a fresh preview after a send that failed before anything went out', async () => {
    const p = portal({ saveDraftAnswer: '<title>Oops!</title>' });
    const t = tool(p);
    const preview = await t.raw({ conversationId: HTH, body: 'x' });
    const args = { conversationId: HTH, body: 'x', confirmToken: preview.confirmToken };
    await expect(t.raw(args)).rejects.toThrow(/SaveReplyDraft/);
    expect((await t.raw(args)).error).toBe('TOKEN_REUSED');
    const fresh = await t.raw({ conversationId: HTH, body: 'x' });
    await expect(t.raw({ ...args, confirmToken: fresh.confirmToken })).rejects.toThrow(/SaveReplyDraft/);
    expect(endpoints(p).filter((e) => e.endsWith('SendReply'))).toEqual([]);
  });

  it('gives two previews of the same reply distinct tokens, each good once', async () => {
    const p = portal();
    const t = tool(p);
    const a = await t.raw({ conversationId: HTH, body: BODY });
    const b = await t.raw({ conversationId: HTH, body: BODY });
    expect(a.confirmToken).not.toBe(b.confirmToken);
    expect((await t.raw({ conversationId: HTH, body: BODY, confirmToken: a.confirmToken })).sent).toBe(true);
    expect((await t.raw({ conversationId: HTH, body: BODY, confirmToken: b.confirmToken })).sent).toBe(true);
  });
});

// ── Hosted uploads: signed slots + blobKeys ──────────────────────────────
// On mcp-host the caller shares no filesystem with this server, and base64
// rides inside one capped JSON-RPC request. So the caller PUTs each file to a
// signed slot and names it by blobKey. The blob store is a fake behind a
// stubbed global fetch (the portal transport is separate, so it never sees it).

const BLOB_BASE = 'https://host.example/b/reg_0123456789abcdef01234567';
/** A placeholder reply; the fake portal echoes it back as the sent message. */
const NEUTRAL = 'Please see the attached file.';
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

interface FakeBlobs {
  objects: Map<string, { bytes: Buffer; type: string }>;
  calls: Array<{ method: string; key: string }>;
  failDelete?: boolean;
}

function fakeBlobs(): FakeBlobs {
  vi.stubEnv('MCP_BLOB_BASE_URL', BLOB_BASE);
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', 'a2V5');
  const state: FakeBlobs = { objects: new Map(), calls: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace('/b/reg_0123456789abcdef01234567/', ''));
    const method = init?.method ?? 'GET';
    state.calls.push({ method, key });
    if (method === 'DELETE') {
      if (state.failDelete) return new Response('boom', { status: 500 });
      state.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const obj = state.objects.get(key);
    if (!obj) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(new Uint8Array(obj.bytes), { status: 200, headers: { 'content-type': obj.type } });
  }));
  return state;
}

/** What the caller's curl does: PUT the bytes into the slot. */
const putInto = (blobs: FakeBlobs, slot: { blobKey: string; mimeType: string }, bytes: Buffer): void => {
  blobs.objects.set(slot.blobKey, { bytes, type: slot.mimeType });
};

/** A key in exactly the shape a slot mints, for a name no slot would accept. */
const keyFor = (filename: string): string =>
  `uploads/0f0e0d0c-0b0a-4908-8706-050403020100/${Buffer.from(filename, 'utf8').toString('base64url')}`;

const deletes = (blobs: FakeBlobs): string[] => blobs.calls.filter((c) => c.method === 'DELETE').map((c) => c.key);

describe('hosted uploads', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_BLOB_BASE_URL', '');
    vi.stubEnv('MCP_BLOB_SIGNING_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Mint a slot for `filename` and PUT `bytes` into it, as a caller would. */
  async function uploaded(t: ReturnType<typeof tool>, blobs: FakeBlobs, filename: string, bytes: Buffer = PDF_BYTES) {
    const out = await t.slots({ files: [{ filename }] });
    const slot = (out.slots as Array<{ blobKey: string; mimeType: string }>)[0]!;
    putInto(blobs, slot, bytes);
    return slot.blobKey;
  }

  describe('mah_upload_slots', () => {
    it('is annotated read-only and points at mah_reply_message', () => {
      const t = tool(portal());
      expect(t.slotsDef.annotations).toMatchObject({ readOnlyHint: true });
      expect(t.slotsDef.description).toMatch(/mah_reply_message/);
      expect(t.slotsDef.description).toMatch(/blobKeys/);
    });

    it('mints a signed PUT slot per file, with the next step, and touches nothing on the portal', async () => {
      const blobs = fakeBlobs();
      const p = portal();
      const out = await tool(p).slots({ files: [{ filename: 'scan.pdf' }, { filename: 'photo one.jpg' }] });
      const slots = out.slots as Array<Record<string, string>>;
      expect(slots).toHaveLength(2);
      expect(slots[0]).toMatchObject({ filename: 'scan.pdf', mimeType: 'application/pdf', method: 'PUT' });
      expect(slots[1]).toMatchObject({ filename: 'photo one.jpg', mimeType: 'image/jpeg' });
      expect(slots[0]!.blobKey).toMatch(/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/);
      expect(slots[0]!.uploadUrl.startsWith(BLOB_BASE)).toBe(true);
      expect(slots[0]!.curl).toContain("Content-Type: application/pdf");
      expect(out.blobKeys).toEqual(slots.map((s) => s.blobKey));
      expect(String(out.next)).toMatch(/mah_reply_message/);
      expect(String(out.next)).toMatch(/blobKeys/);
      expect(p.calls).toEqual([]);
      expect(blobs.calls).toEqual([]);
    });

    it('types a portal format the generic table does not know from the portal\'s own list', async () => {
      fakeBlobs();
      const out = await tool(portal()).slots({ files: [{ filename: 'clip.wmv' }] });
      expect((out.slots as Array<Record<string, string>>)[0]!.mimeType).toBe('video/x-ms-wmv');
    });

    it('refuses without a blob store, saying base64 attachments still work', async () => {
      await expect(tool(portal()).slots({ files: [{ filename: 'scan.pdf' }] })).rejects.toThrow(
        /blob store[\s\S]*attachments/i,
      );
    });

    it('refuses a file type the portal never accepts', async () => {
      fakeBlobs();
      await expect(tool(portal()).slots({ files: [{ filename: 'run.exe' }] })).rejects.toThrow(/EXE/);
    });

    it('refuses a path or hidden file as a filename', async () => {
      fakeBlobs();
      await expect(tool(portal()).slots({ files: [{ filename: 'dir/scan.pdf' }] })).rejects.toThrow(/bare filename/);
      await expect(tool(portal()).slots({ files: [{ filename: '.scan.pdf' }] })).rejects.toThrow(/dot/);
    });

    it('refuses more than 10 files', async () => {
      fakeBlobs();
      const files = Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}.pdf` }));
      await expect(tool(portal()).slots({ files })).rejects.toThrow(/10/);
    });

    it('refuses when attachments cannot be sent at all (browser bridge)', async () => {
      fakeBlobs();
      await expect(
        tool(portal(), { attachmentsSupported: false }).slots({ files: [{ filename: 'scan.pdf' }] }),
      ).rejects.toThrow(/bridge/i);
    });
  });

  describe('mah_reply_message with blobKeys', () => {
    it('the preview reads each blob, binds it, and neither deletes nor sends', async () => {
      const blobs = fakeBlobs();
      const p = portal();
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      const out = await t.raw({ conversationId: HTH, body: 'see attached', blobKeys: [key] });
      expect(typeof out.confirmToken).toBe('string');
      expect(JSON.stringify(out)).toContain('scan.pdf');
      expect(blobs.calls).toEqual([{ method: 'GET', key }]);
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
      expect(blobs.objects.has(key)).toBe(true);
    });

    it('the confirmed send uploads the blob\'s bytes, attaches it, and deletes it only after SendReply', async () => {
      const blobs = fakeBlobs();
      const p = portal({ newBodyLines: [NEUTRAL] });
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      let deletesAtSend: string[] | undefined;
      p.on['SendReply'] = () => {
        deletesAtSend = deletes(blobs);
      };
      const out = await t.call({ conversationId: HTH, body: NEUTRAL, blobKeys: [key], confirm: true });
      expect(out.sent).toBe(true);
      const up = p.calls.find((c) => c.path === 'DocumentUpload/UploadFile')!;
      const file = (up.body as FormData).get('__file__[]') as File;
      expect(file.name).toBe('scan.pdf');
      expect(file.type).toBe('application/pdf');
      expect(Buffer.from(await file.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
      const send = JSON.parse(p.calls.find((c) => c.path.endsWith('SendReply'))!.body as string);
      expect(send.documentIds).toEqual([DOC]);
      expect(deletesAtSend).toEqual([]);
      expect(deletes(blobs)).toEqual([key]);
      expect(blobs.objects.has(key)).toBe(false);
      expect(out.uploadStore).toEqual({ deleted: ['scan.pdf'] });
    });

    it('sends base64 attachments and blobs together, in that order', async () => {
      const blobs = fakeBlobs();
      const p = portal({ newBodyLines: [NEUTRAL] });
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      const out = await t.call({
        conversationId: HTH,
        body: NEUTRAL,
        attachments: [{ filename: 'photo.png', contentBase64: png }],
        blobKeys: [key],
        confirm: true,
      });
      expect(out.sent).toBe(true);
      const names = p.calls
        .filter((c) => c.path === 'DocumentUpload/UploadFile')
        .map((c) => ((c.body as FormData).get('__file__[]') as File).name);
      expect(names).toEqual(['photo.png', 'scan.pdf']);
    });

    it('keeps the blob when the send fails before anything went out', async () => {
      const blobs = fakeBlobs();
      const p = portal({ saveDraftAnswer: '<title>Oops!</title>' });
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      await expect(t.call({ conversationId: HTH, body: 'x', blobKeys: [key], confirm: true })).rejects.toThrow();
      expect(deletes(blobs)).toEqual([]);
      expect(blobs.objects.has(key)).toBe(true);
    });

    it('keeps the blob when the send is uncertain', async () => {
      const blobs = fakeBlobs();
      const p = portal({ sendReplyAnswer: '""' });
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      await expect(t.call({ conversationId: HTH, body: 'not what the thread shows', blobKeys: [key], confirm: true })).rejects.toThrow(/may have been sent/);
      expect(deletes(blobs)).toEqual([]);
    });

    it('refuses a blob whose bytes changed after the preview, and sends nothing', async () => {
      const blobs = fakeBlobs();
      const p = portal();
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      const args = { conversationId: HTH, body: 'see attached', blobKeys: [key] };
      const preview = await t.raw(args);
      blobs.objects.set(key, { bytes: Buffer.from('%PDF-1.7\nswapped\n'), type: 'application/pdf' });
      const out = await t.raw({ ...args, confirmToken: preview.confirmToken });
      expect(out.error).toBe('DRAFT_CHANGED');
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
      expect(deletes(blobs)).toEqual([]);
    });

    it('applies the portal\'s file-type limit to blobs', async () => {
      const blobs = fakeBlobs();
      const p = portal();
      const key = keyFor('run.exe');
      blobs.objects.set(key, { bytes: PDF_BYTES, type: 'application/octet-stream' });
      await expect(tool(p).call({ conversationId: HTH, body: 'x', blobKeys: [key], confirm: true })).rejects.toThrow(/EXE/);
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
    });

    it('applies the portal\'s size limit to blobs', async () => {
      const blobs = fakeBlobs();
      const p = portal();
      const t = tool(p);
      const key = await uploaded(t, blobs, 'big.pdf', Buffer.alloc(10240 * 1024 + 1));
      await expect(t.call({ conversationId: HTH, body: 'x', blobKeys: [key], confirm: true })).rejects.toThrow(/big\.pdf is too large/);
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
    });

    it('refuses an empty blob', async () => {
      const blobs = fakeBlobs();
      const t = tool(portal());
      const key = await uploaded(t, blobs, 'empty.pdf', Buffer.alloc(0));
      await expect(t.raw({ conversationId: HTH, body: 'x', blobKeys: [key] })).rejects.toThrow(/empty\.pdf is empty/);
    });

    it('counts base64 attachments and blobs together against the portal\'s maximum', async () => {
      const blobs = fakeBlobs();
      const p = portal();
      const t = tool(p);
      const a = await uploaded(t, blobs, 'a.pdf');
      const b = await uploaded(t, blobs, 'b.pdf');
      const f = { filename: 'c.png', contentBase64: png };
      await expect(
        t.call({ conversationId: HTH, body: 'x', attachments: [f, f], blobKeys: [a, b], confirm: true }),
      ).rejects.toThrow(/at most 3/);
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
      expect(blobs.calls.filter((c) => c.method === 'GET')).toEqual([]);
    });

    it('refuses a key that is not an upload slot\'s', async () => {
      const blobs = fakeBlobs();
      blobs.objects.set('exports/report.pdf', { bytes: PDF_BYTES, type: 'application/pdf' });
      await expect(
        tool(portal()).raw({ conversationId: HTH, body: 'x', blobKeys: ['exports/report.pdf'] }),
      ).rejects.toThrow(/not an upload key[\s\S]*mah_upload_slots/);
      expect(blobs.calls).toEqual([]);
    });

    it('says when a blob is missing (never PUT, expired, or already used)', async () => {
      fakeBlobs();
      await expect(
        tool(portal()).raw({ conversationId: HTH, body: 'x', blobKeys: [keyFor('scan.pdf')] }),
      ).rejects.toThrow(/scan\.pdf[\s\S]*could not be read/);
    });

    it('refuses blobKeys without a blob store, before touching the portal\'s write endpoints', async () => {
      const p = portal();
      await expect(
        tool(p).raw({ conversationId: HTH, body: 'x', blobKeys: [keyFor('scan.pdf')] }),
      ).rejects.toThrow(/blob store/i);
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
    });

    it('reports a failed delete after a successful send, without failing it', async () => {
      const blobs = fakeBlobs();
      const p = portal({ newBodyLines: [NEUTRAL] });
      const t = tool(p);
      const key = await uploaded(t, blobs, 'scan.pdf');
      blobs.failDelete = true;
      const out = await t.call({ conversationId: HTH, body: NEUTRAL, blobKeys: [key], confirm: true });
      expect(out.sent).toBe(true);
      const store = out.uploadStore as { deleted: string[]; notDeleted: Array<{ filename: string; error: string }> };
      expect(store.deleted).toEqual([]);
      expect(store.notDeleted).toHaveLength(1);
      expect(store.notDeleted[0]!.filename).toBe('scan.pdf');
      expect(store.notDeleted[0]!.error).not.toContain(BLOB_BASE);
    });
  });

  describe('strict base64', () => {
    it('refuses a truncated payload, naming the file, instead of sending a corrupt one', async () => {
      const p = portal();
      // `png` with its final character cut off: Buffer.from would silently decode it.
      const truncated = png.slice(0, -1);
      await expect(
        tool(p).call({ conversationId: HTH, body: 'x', attachments: [{ filename: 'scan.png', contentBase64: truncated }], confirm: true }),
      ).rejects.toThrow(/scan\.png[\s\S]*not valid base64/);
      expect(endpoints(p).filter((e) => mutating.test(e))).toEqual([]);
    });

    it('still accepts line-wrapped base64', async () => {
      const p = portal();
      const wrapped = PDF_BYTES.toString('base64').replace(/(.{8})/g, '$1\n');
      const out = await tool(p).raw({ conversationId: HTH, body: 'x', attachments: [{ filename: 'scan.pdf', contentBase64: wrapped }] });
      expect(typeof out.confirmToken).toBe('string');
    });
  });
});
