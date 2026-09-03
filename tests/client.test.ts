import { describe, expect, it } from 'vitest';
import { MyAtriumHealthClient } from '../src/client.js';
import type { FetchInit, FetchResult, MahTransport } from '../src/transport.js';

const TOKEN = 'a'.repeat(172);
const signedInPage = (token = TOKEN): string =>
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<script id='cspScripts' nonce='0123456789abcdef0123456789abcdef'></script>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${token}" /></body></html>`;
const loginPage = `<html><head><title>MyAtriumHealth - Login Page</title></head><body>
  <input name="__RequestVerificationToken" value="${'b'.repeat(172)}" /></body></html>`;

class FakeTransport implements MahTransport {
  calls: FetchInit[] = [];
  constructor(private readonly responder: (init: FetchInit) => FetchResult) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    return this.responder(init);
  }
}

const ok = (body: string): FetchResult => ({ status: 200, body });

describe('MyAtriumHealthClient', () => {
  it('scrapes the antiforgery token and sends it as a header', async () => {
    const t = new FakeTransport((i) =>
      i.path.startsWith('api/') ? ok('{"dataList":[]}') : ok(signedInPage()));
    const c = new MyAtriumHealthClient({ transport: t });
    await c.api('allergies/LoadAllergies');
    const apiCall = t.calls.find((x) => x.path.startsWith('api/'))!;
    expect(apiCall.method).toBe('POST');
    expect(apiCall.headers?.__RequestVerificationToken).toBe(TOKEN);
    expect(apiCall.headers?.['Content-Type']).toBe('application/json');
    expect(apiCall.body).toBe('{}');
  });

  it('caches the token across calls — one page fetch, not one per request', async () => {
    const t = new FakeTransport((i) =>
      i.path.startsWith('api/') ? ok('{}') : ok(signedInPage()));
    const c = new MyAtriumHealthClient({ transport: t });
    await c.api('allergies/LoadAllergies');
    await c.api('goals/LoadPatientGoals');
    expect(t.calls.filter((x) => !x.path.startsWith('api/'))).toHaveLength(1);
  });

  // MyChart answers an expired session with 200 + the login page, never a 401.
  it('treats a 200 login page as an expired session, not a success', async () => {
    const t = new FakeTransport(() => ok(loginPage));
    const c = new MyAtriumHealthClient({ transport: t });
    await expect(c.api('allergies/LoadAllergies')).rejects.toThrow(/signed in|expired|session/i);
  });

  it('never sends the login page token', async () => {
    const t = new FakeTransport(() => ok(loginPage));
    const c = new MyAtriumHealthClient({ transport: t });
    await c.api('allergies/LoadAllergies').catch(() => {});
    expect(t.calls.every((x) => x.headers?.__RequestVerificationToken !== 'b'.repeat(172))).toBe(true);
  });


  // An empty body means the bridge relayed nothing (no signed-in tab open),
  // NOT that the portal answered. Reporting that as a generic "did not return
  // JSON" sends people to look at the endpoint instead of their browser.
  it('names the bridge when the response body is empty', async () => {
    const t = new FakeTransport(() => ok(''));
    const c = new MyAtriumHealthClient({ transport: t });
    await expect(c.api('allergies/LoadAllergies')).rejects.toThrow(/empty|no signed-in tab|bridge/i);
  });

  it('does not mistake an empty page for a signed-in one', async () => {
    const t = new FakeTransport(() => ok(''));
    const c = new MyAtriumHealthClient({ transport: t });
    await expect(c.page('Home')).rejects.toThrow(/empty|no signed-in tab|bridge/i);
  });

  it('surfaces an HTML error page as an error rather than parsing it', async () => {
    const t = new FakeTransport((i) =>
      i.path.startsWith('api/')
        ? ok('<html><title>MyAtriumHealth - Oops!</title></html>')
        : ok(signedInPage()));
    const c = new MyAtriumHealthClient({ transport: t });
    await expect(c.api('conversations/GetOrganizations')).rejects.toThrow(/did not return JSON|Oops/i);
  });

  it('reads the CSP nonce from single-quoted markup', async () => {
    const t = new FakeTransport(() => ok(signedInPage()));
    const c = new MyAtriumHealthClient({ transport: t });
    expect(await c.pageNonce('app/communication-center')).toBe('0123456789abcdef0123456789abcdef');
  });

  it('posts legacy endpoints form-encoded with a noCache buster', async () => {
    const t = new FakeTransport((i) =>
      i.path.includes('VisitsList') ? ok('{"LaterVisitsList":[]}') : ok(signedInPage()));
    const c = new MyAtriumHealthClient({ transport: t });
    await c.legacy('Visits/VisitsList/LoadUpcoming', { ComponentNumber: '5' });
    const call = t.calls.find((x) => x.path.includes('VisitsList'))!;
    expect(call.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call.path).toMatch(/ComponentNumber=5/);
    expect(call.path).toMatch(/noCache=/);
  });
});

describe('conversation list body assembly', () => {
  const NONCE = '0123456789abcdef0123456789abcdef';
  const orgs = {
    organizations: {
      LOCALHANDLE: { isLocal: true, organizationName: 'Local', hasCommunicationCenter: true },
      EXT1: { isLocal: false, organizationName: 'Ext One', hasCommunicationCenter: true },
      EXT2: { isLocal: false, organizationName: 'Ext Two', hasCommunicationCenter: true },
    },
  };
  const page =
    `<html><head><title>MyAtriumHealth - Messages</title></head>` +
    `<script id='cspScripts' nonce='${NONCE}'></script>` +
    `<input name="__RequestVerificationToken" value="${TOKEN}" /></html>`;

  function harness() {
    const t = new FakeTransport((i) => {
      if (i.path.startsWith('api/conversations/GetOrganizations')) return ok(JSON.stringify(orgs));
      if (i.path.startsWith('api/conversations/GetConversationList')) return ok('{"conversations":[]}');
      return ok(page);
    });
    return { t, c: new MyAtriumHealthClient({ transport: t }) };
  }

  it('sends only NON-local orgs in externalLoadParams', async () => {
    const { t, c } = harness();
    await c.listConversations(1);
    const call = t.calls.find((x) => x.path.startsWith('api/conversations/GetConversationList'))!;
    const body = JSON.parse(call.body as string);
    // The local org belongs in localLoadParams; including it makes the API 500.
    expect(Object.keys(body.externalLoadParams).sort()).toEqual(['EXT1', 'EXT2']);
  });

  it('sends all five required keys, including the page nonce', async () => {
    const { t, c } = harness();
    await c.listConversations(2);
    const body = JSON.parse(
      t.calls.find((x) => x.path.startsWith('api/conversations/GetConversationList'))!.body as string,
    );
    expect(Object.keys(body).sort()).toEqual([
      'PageNonce', 'externalLoadParams', 'localLoadParams', 'searchQuery', 'tag',
    ]);
    expect(body.PageNonce).toBe(NONCE);
    expect(body.tag).toBe(2);
    expect(body.localLoadParams).toEqual({
      loadStartInstantISO: '', loadEndInstantISO: '', pagingInfo: 1,
    });
  });
});

describe('legacy form bodies', () => {
  it('sends form fields in the body, not the query string', async () => {
    const t = new FakeTransport((i) =>
      i.path.includes('GetCoverages') ? ok('{"ActiveCoverages":[]}') : ok(signedInPage()));
    const c = new MyAtriumHealthClient({ transport: t });
    await c.legacy('Insurance/Coverages/GetCoverages', {}, { isStandAlone: 'true' });
    const call = t.calls.find((x) => x.path.includes('GetCoverages'))!;
    expect(call.body).toBe('isStandAlone=true');
    expect(call.path).not.toContain('isStandAlone');
  });
});
