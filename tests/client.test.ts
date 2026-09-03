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
