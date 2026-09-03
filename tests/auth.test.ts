import { describe, expect, it, vi } from 'vitest';
import { MyAtriumHealthAuth, MfaRequiredError } from '../src/auth.js';

const USER = 'testuser';
const PASS = 'sup3r-s3cret-p@ssw0rd';
const TOKEN = 'a'.repeat(172);

const loginPage = `<html><head><title>MyAtriumHealth - Login Page</title></head>
  <input name="__RequestVerificationToken" value="${TOKEN}" /></html>`;

/** Minimal fetch double: records calls, replies from a scripted table. */
function harness(script: (url: string, init?: RequestInit) => Partial<Response> & { body?: string }) {
  const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method: init?.method ?? 'GET', body, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = script(url, init);
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers as HeadersInit ?? {}),
      text: async () => r.body ?? '',
      url,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const memoryStore = () => {
  let rec: unknown = null;
  return { load: () => rec as never, save: (v: unknown) => { rec = v; }, clear: () => { rec = null; } };
};

const creds = () => ({ username: USER, password: PASS });

describe('server-side login', () => {
  it('posts LoginInfo with base64 credentials under LoginIdentifier', async () => {
    const { calls, fetchImpl } = harness((url) =>
      url.includes('DoLogin')
        ? { status: 302, headers: { location: '/myatriumhealth/Home' } }
        : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    await auth.login().catch(() => {});
    const post = calls.find((c) => c.url.includes('DoLogin'))!;
    const form = new URLSearchParams(post.body);
    const info = JSON.parse(form.get('LoginInfo')!);
    expect(info.Type).toBe('StandardLogin');
    expect(Buffer.from(info.Credentials.LoginIdentifier, 'base64').toString('utf8')).toBe(USER);
    expect(Buffer.from(info.Credentials.Password, 'base64').toString('utf8')).toBe(PASS);
    expect(form.get('__RequestVerificationToken')).toBe(TOKEN);
  });

  // Behaviour deliberately inverted after measurement: sending this portal's
  // RememberDeviceId does NOT skip verification, and it breaks the challenge —
  // the SecondaryValidation page then renders without its templateContext, so
  // the antiforgery token cannot be read and SendCode 500s. Session continuity
  // comes from the persisted cookie jar instead.
  it('does NOT send the device token on login, because it poisons the challenge', async () => {
    const store = memoryStore();
    store.save({ deviceId: 'DEV-123', username: USER } as never);
    const { calls, fetchImpl } = harness((url) =>
      url.includes('DoLogin')
        ? { status: 302, headers: { location: '/myatriumhealth/Home' } }
        : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    await auth.login().catch(() => {});
    const form = new URLSearchParams(calls.find((c) => c.url.includes('DoLogin'))!.body);
    expect(form.get('DeviceId')).toBeNull();
  });

  it('raises a typed MfaRequiredError when redirected to SecondaryValidation', async () => {
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) return { status: 302, headers: { location: '/myatriumhealth/Home' } };
      if (url.includes('SecondaryValidation')) return { body: '<title>MyAtriumHealth - Extra Security Required</title>' };
      if (url.includes('/Home')) return { status: 302, headers: { location: '/myatriumhealth/Authentication/SecondaryValidation' } };
      return { body: loginPage };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    await expect(auth.login()).rejects.toBeInstanceOf(MfaRequiredError);
  });

  // kiaaccess precedent: redaction helpers match secret SHAPES and do NOT catch
  // a password. Assert the OUTCOME (no password in the text), not the mechanism.
  it('never puts the password in an error message', async () => {
    const { fetchImpl } = harness((url) =>
      url.includes('DoLogin')
        ? { status: 500, body: `upstream exploded while handling ${PASS}` }
        : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    const err = await auth.login().then(() => null, (e: Error) => e);
    expect(err).toBeTruthy();
    expect(JSON.stringify(err)).not.toContain(PASS);
    expect(String((err as Error).message)).not.toContain(PASS);
  });
});

describe('MFA bootstrap', () => {
  it('sends a code on the chosen channel', async () => {
    const { calls, fetchImpl } = harness((url) =>
      url.includes('SendCode') ? { body: '{"Success":true}' } : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    await auth.sendCode('sms');
    const form = new URLSearchParams(calls.find((c) => c.url.includes('SendCode'))!.body);
    expect(form.get('deliveryMethodSMS')).toBe('true');
    expect(form.get('resendCode')).toBe('false');
  });

  it('verifies the code and persists the returned device token', async () => {
    const store = memoryStore();
    const { calls, fetchImpl } = harness((url) =>
      url.includes('Validate')
        ? { body: '{"Success":true,"RememberDeviceId":"NEW-DEVICE-TOKEN"}' }
        : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    const res = await auth.verifyCode('123456');
    expect(res.remembered).toBe(true);
    const form = new URLSearchParams(calls.find((c) => c.url.includes('Validate'))!.body);
    expect(form.get('TwoFactorCode')).toBe('123456');
    expect(form.get('RememberMe')).toBe('checked');
    expect((store.load() as unknown as { deviceId: string }).deviceId).toBe('NEW-DEVICE-TOKEN');
  });

  it('reports a rejected code without persisting anything', async () => {
    const store = memoryStore();
    const { fetchImpl } = harness((url) =>
      url.includes('Validate') ? { body: '{"Success":false}' } : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    await expect(auth.verifyCode('000000')).rejects.toThrow(/code/i);
    expect(store.load()).toBeNull();
  });
});

describe('challenge context parsing', () => {
  // Shape copied from the live page: a JS literal with .NET-style True/False
  // and unquoted keys — NOT valid JSON, so JSON.parse cannot be used.
  const page = `<html><script>
    var templateContext = {
    TwoFactorSettings : {
    Enabled : True,
    AllowEmail : True,
    AllowSMS: False,
    AllowTotp:True,
    AllowMultiple:True,
    ShowRecip: True,
    DisplayEmail: "ch****l@example.com",
    DisplayPhone: "***-***-6609",
    Workflow: 3,
    },
    RememberMeSettings : { Enabled : True, EnrollDeviceTracking: False },
    };</script></html>`;

  it('reads the channels the account actually allows', async () => {
    const { parseChallengeContext } = await import('../src/auth.js');
    const ctx = parseChallengeContext(page)!;
    expect(ctx.channels.sort()).toEqual(['email', 'totp']);   // SMS is False here
    expect(ctx.displayEmail).toBe('ch****l@example.com');
    expect(ctx.displayPhone).toBe('***-***-6609');
  });

  it('captures Workflow, without which SendCode is refused', async () => {
    const { parseChallengeContext } = await import('../src/auth.js');
    expect(parseChallengeContext(page)!.workflow).toBe(3);
  });

  it('reads the remember-device settings', async () => {
    const { parseChallengeContext } = await import('../src/auth.js');
    const ctx = parseChallengeContext(page)!;
    expect(ctx.rememberMeEnabled).toBe(true);
    expect(ctx.enrollDeviceTracking).toBe(false);
  });

  it('returns null when the page carries no context', async () => {
    const { parseChallengeContext } = await import('../src/auth.js');
    expect(parseChallengeContext('<html>nothing</html>')).toBeNull();
  });
});

describe('a pending challenge is not re-attempted', () => {
  it('does not re-submit credentials once verification is already required', async () => {
    let logins = 0;
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) { logins++; return { status: 302, headers: { location: '/myatriumhealth/Home' } }; }
      if (url.includes('SecondaryValidation')) return { body: '<title>Extra Security Required</title>' };
      if (url.endsWith('/Home')) return { status: 302, headers: { location: '/myatriumhealth/Authentication/SecondaryValidation' } };
      return { body: loginPage };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    const { ServerTransport } = await import('../src/transport-server.js');
    const t = new ServerTransport(auth);
    // Three tool calls while unverified must cost ONE credential submission,
    // not three: repeated logins are wasteful and look like an attack.
    for (let i = 0; i < 3; i++) await t.fetch({ method: 'GET', path: 'Home' }).catch(() => {});
    expect(logins).toBe(1);
  });

  it('clears the pending challenge once a code is verified', async () => {
    const { fetchImpl } = harness((url) =>
      url.includes('Validate')
        ? { body: '{"Success":true,"RememberDeviceId":"D1"}' }
        : { body: loginPage });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    (auth as unknown as { mfaPending: boolean }).mfaPending = true;
    await auth.verifyCode('123456');
    expect((auth as unknown as { mfaPending: boolean }).mfaPending).toBe(false);
  });
});

describe('auto-review findings (PR #8)', () => {
  const homeLogin = { status: 200, body: '<html><head><title>MyAtriumHealth - Login Page</title></head></html>' };

  it('does not report success when the landing page is the login page', async () => {
    // A rejected password can land here with no error marker; returning
    // signedIn:true made a failed login look like a working session.
    let logins = 0;
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) { logins++; return { status: 302, headers: { location: '/myatriumhealth/Home' } }; }
      if (url.endsWith('/Home')) return homeLogin;
      return { body: loginPage };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    await expect(auth.login()).rejects.toThrow(/rejected|credential/i);
    expect(logins).toBe(1);
  });

  it('persists the cookie jar on an unchallenged login, not only after verifying', async () => {
    const store = memoryStore();
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) {
        return { status: 302, headers: { location: '/myatriumhealth/Home', 'set-cookie': 'SESS=abc; Path=/' } };
      }
      if (url.endsWith('/Home')) return { status: 200, body: '<title>MyAtriumHealth - Home</title>' };
      return { body: loginPage };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    await auth.login();
    const rec = store.load() as unknown as { cookies?: [string, string][] } | null;
    expect(rec?.cookies?.length ?? 0).toBeGreaterThan(0);
  });

  it('treats an empty stored device token as absent', async () => {
    const store = memoryStore();
    store.save({ deviceId: '', username: USER } as never);
    const { fetchImpl } = harness(() => ({ body: loginPage }));
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    expect(auth.deviceId()).toBeUndefined();
  });

  it('clears a pending challenge when a login succeeds without one', async () => {
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) return { status: 302, headers: { location: '/myatriumhealth/Home' } };
      if (url.endsWith('/Home')) return { status: 200, body: '<title>MyAtriumHealth - Home</title>' };
      return { body: loginPage };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    (auth as unknown as { mfaPending: boolean }).mfaPending = true;
    await auth.login();
    expect((auth as unknown as { mfaPending: boolean }).mfaPending).toBe(false);
  });

  it('does not treat IsEnabled as Enabled when reading remember-me settings', async () => {
    const { parseChallengeContext } = await import('../src/auth.js');
    const page = `<script>var templateContext = {
      TwoFactorSettings : { AllowEmail : True, Workflow: 1, },
      RememberMeSettings : { IsEnabled : True, Enabled : False, EnrollDeviceTracking: False },
    };</script>`;
    expect(parseChallengeContext(page)!.rememberMeEnabled).toBe(false);
  });
});

describe('ServerTransport session handling', () => {
  const signedInHome = { status: 200, body: '<title>MyAtriumHealth - Home</title>' };

  it('resumes a stored session without logging in at all', async () => {
    let logins = 0;
    const store = memoryStore();
    store.save({ deviceId: '', username: USER, cookies: [['SESS', 'abc']] } as never);
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) { logins++; return { status: 302, headers: { location: '/myatriumhealth/Home' } }; }
      return signedInHome;
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    const { ServerTransport } = await import('../src/transport-server.js');
    await new ServerTransport(auth).fetch({ method: 'GET', path: 'Home' });
    expect(logins).toBe(0);
  });

  it('a live session beats a stale pending-challenge flag', async () => {
    const store = memoryStore();
    store.save({ deviceId: '', username: USER, cookies: [['SESS', 'abc']] } as never);
    const { fetchImpl } = harness(() => signedInHome);
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: store });
    (auth as unknown as { mfaPending: boolean }).mfaPending = true;
    const { ServerTransport } = await import('../src/transport-server.js');
    await expect(
      new ServerTransport(auth).fetch({ method: 'GET', path: 'Home' }),
    ).resolves.toBeTruthy();
  });

  it('re-logs in and replays EXACTLY once when a response is the login page', async () => {
    let logins = 0;
    let dataHits = 0;
    const { fetchImpl } = harness((url) => {
      if (url.includes('Authentication/Login') && !url.includes('DoLogin')) return { body: loginPage };
      if (url.includes('DoLogin')) { logins++; return { status: 302, headers: { location: '/myatriumhealth/Home' } }; }
      if (url.endsWith('/Home')) return signedInHome;
      dataHits++;
      // Always the login page: the transport must give up, not loop, because
      // each retry is another credential submission.
      return { status: 200, body: '<title>MyAtriumHealth - Login Page</title>' };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    const { ServerTransport } = await import('../src/transport-server.js');
    await expect(
      new ServerTransport(auth).fetch({ method: 'GET', path: 'api/x/Y' }),
    ).rejects.toThrow(/could not be re-established/i);
    expect(dataHits).toBe(2);      // original + exactly one replay
    expect(logins).toBeLessThanOrEqual(2);
  });
});

describe('healthcheck must not authenticate', () => {
  it('probing a signed-out session submits no credentials', async () => {
    let logins = 0;
    const { fetchImpl } = harness((url) => {
      if (url.includes('DoLogin')) { logins++; return { status: 302, headers: { location: '/myatriumhealth/Home' } }; }
      return { body: loginPage };
    });
    const auth = new MyAtriumHealthAuth({ fetchImpl, credentials: creds, persistence: memoryStore() });
    // What the healthcheck's probeFn does: a raw request on the auth jar.
    await auth.request('Home');
    expect(logins).toBe(0);
  });
});
