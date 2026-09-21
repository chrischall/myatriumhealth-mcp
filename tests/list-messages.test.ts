import { describe, expect, it } from 'vitest';
import { MyAtriumHealthClient } from '../src/client.js';
import type { FetchResult, MahTransport } from '../src/transport.js';
import { PatientContext } from '../src/patient-context.js';
import { registerAccountTools } from '../src/tools/account.js';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<script id='cspScripts' nonce='0123456789abcdef0123456789abcdef'></script>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;

// Captured 2026-09-21: `messages[]` is OLDEST first, and the thread id is
// `hthId` — the id mah_reply_message takes.
const list = {
  conversations: [
    {
      hthId: 'WP-24thread',
      subject: 'Zepbound refill',
      userKeys: ['WP-24provider'],
      messages: [
        { wmgId: 'WP-24a', deliveryInstantISO: '2026-08-19T21:01:48Z', isUnread: false },
        { wmgId: 'WP-24b', deliveryInstantISO: '2026-09-21T18:08:32Z', isUnread: false },
      ],
    },
  ],
  users: { 'WP-24provider': { name: 'Vibhu Dhingra, MD' } },
};

function listMessages() {
  const json = (v: unknown): FetchResult => ({ status: 200, body: JSON.stringify(v) });
  const transport: MahTransport = {
    start: async () => {},
    close: async () => {},
    fetch: async (init) => {
      if (!init.path.startsWith('api/')) return { status: 200, body: signedInPage };
      if (init.path.endsWith('FetchHealthSummary')) return json({ patientFirstName: 'Christopher', header: { patientAge: 45 } });
      if (init.path.endsWith('GetOrganizations')) return json({ organizations: {} });
      return json(list);
    },
  };
  let handler: ((a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined;
  const server = {
    registerTool: (name: string, _def: unknown, fn: typeof handler) => {
      if (name === 'mah_list_messages') handler = fn;
    },
  } as never;
  process.env.MAH_PATIENT_FILE = `/tmp/mah-list-${Date.now()}-${Math.random()}.json`;
  registerAccountTools(server, new MyAtriumHealthClient({ transport }), new PatientContext());
  return async () => JSON.parse((await handler!({ folder: 1 })).content[0]!.text) as { data: Record<string, unknown>[] };
}

describe('mah_list_messages compact projection', () => {
  it('reports the thread id a reply needs', async () => {
    const out = await listMessages()();
    expect(out.data[0]).toMatchObject({ conversationId: 'WP-24thread', lastMessageId: 'WP-24b' });
  });

  it('dates a thread by its LATEST message, not its oldest', async () => {
    const out = await listMessages()();
    expect(out.data[0]!.date).toBe('2026-09-21T18:08:32Z');
  });
});

describe('the browser bridge', () => {
  // fetchproxy relays a request body as a UTF-8 string; binary multipart does
  // not survive that. Refusing is the honest answer, not a corrupted upload.
  it('refuses a binary request body rather than corrupting it', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    await expect(
      t.fetch({ method: 'POST', path: 'DocumentUpload/UploadFile', body: new FormData() }),
    ).rejects.toThrow(/bridge/i);
  });
});
