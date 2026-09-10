import { describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { MyAtriumHealthAuth, type DeviceRecord } from '../src/auth.js';
import { MyAtriumHealthClient } from '../src/client.js';
import { registerMahHealthcheckTool } from '../src/tools/healthcheck.js';
import type { MahTransport } from '../src/transport.js';

interface Result {
  ok: boolean;
  credential?: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  bridge?: unknown;
  probe: { url?: string; elapsed_ms: number; status?: number };
  error?: { kind: string; message: string };
  hint: string;
}

/** A cookie jar that never persists, so each test starts from nothing. */
const noStore = {
  load: () => null as DeviceRecord | null,
  save: () => {},
  clear: () => {},
};

/** The signed-out portal's answer: a login page, served 200. */
const LOGIN_PAGE = '<html><head><title>MyChart - Login Page</title></head><body></body></html>';
/** A signed-in page, which is what a healthy probe must be able to tell apart. */
const HOME_PAGE = '<html><head><title>MyChart - Home</title></head><body>ok</body></html>';

function authWith(body: string, status = 200): MyAtriumHealthAuth {
  return new MyAtriumHealthAuth({
    credentials: () => ({ username: 'u', password: 'p' }),
    persistence: noStore,
    fetchImpl: async () => new Response(body, { status }),
  });
}

const stubTransport: MahTransport = {
  start: async () => {},
  close: async () => {},
  fetch: async () => ({ status: 200, body: HOME_PAGE }),
};

async function healthcheck(auth: MyAtriumHealthAuth | undefined): Promise<Result> {
  const client = new MyAtriumHealthClient({ transport: stubTransport });
  const h = await createTestHarness((server) =>
    registerMahHealthcheckTool(server, client, { auth, bridge: undefined }),
  );
  const res = await h.callTool('mah_healthcheck');
  await h.close();
  return parseToolResult<Result>(res as never);
}

// A healthcheck exists to name the broken hop. The credential arm's probe is a
// raw request, and this portal answers a dead session with a LOGIN PAGE rather
// than a 401 — so "the fetch resolved" is not "the session works". Reading it
// that way reported `ok: true` and "Credential from 'env' works", which sends
// somebody to debug a tool when the real fix is to sign in.
describe('mah_healthcheck, credential arm', () => {
  it('reports ok when the portal serves a signed-in page', async () => {
    const r = await healthcheck(authWith(HOME_PAGE));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.credential).toMatchObject({ source: 'env', resolved: true });
  });

  it('fails, and names the session, when the portal serves the login page', async () => {
    const r = await healthcheck(authWith(LOGIN_PAGE));
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('session_expired');
    // The remedy, not a restatement of the symptom.
    expect(r.hint).toContain('mah_sign_in');
  });

  it('fails, and names the verification, when a challenge is outstanding', async () => {
    const auth = authWith(LOGIN_PAGE);
    auth.mfaPending = true;
    const r = await healthcheck(auth);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('verification_pending');
    // A pending code is NOT a rejected password: pointing at MAH_PASSWORD here
    // sends somebody to change a credential that is already correct.
    expect(r.hint).toContain('mah_verify_code');
    expect(r.hint).not.toContain('MAH_PASSWORD');
  });

  it('fails, and names the credentials, when the portal refused them', async () => {
    const auth = authWith(LOGIN_PAGE);
    auth.credentialsRejected = true;
    const r = await healthcheck(auth);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.hint).toContain('MAH_PASSWORD');
  });

  it('lets a refused credential outrank a pending verification', async () => {
    // Both flags set. transport-server.ts already resolved this order —
    // retrying a code against a password the portal refuses is futile — and
    // the healthcheck disagreed with it until the ladder moved into mcp-utils,
    // where the order now lives once instead of in two files.
    const auth = authWith(LOGIN_PAGE);
    auth.mfaPending = true;
    auth.credentialsRejected = true;
    const r = await healthcheck(auth);
    expect(r.error?.kind).toBe('credential_rejected');
  });

  it('reports the status when the portal answers an error', async () => {
    const r = await healthcheck(authWith('<html></html>', 503));
    expect(r.ok).toBe(false);
    expect(r.probe.status).toBe(503);
    expect(r.error?.kind).toBe('http');
  });

  it('reports a redirect as a dead session rather than a success', async () => {
    // `redirect: 'manual'`, so the portal bouncing a signed-out request to the
    // login page arrives here as a 302 with an empty body — no auth wall to
    // match on, and a resolved fetch either way.
    const r = await healthcheck(authWith('', 302));
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('session_expired');
  });
});
