// Bridge-less server-side authentication for MyAtriumHealth.
//
// The portal's login is NOT a plain Login/Password form. The shipped controller
// (areas/authentication/scripts/controllers/loginpagecontroller.min.js) builds:
//
//   {Type:"StandardLogin", Credentials:{LoginIdentifier:b64(u), Password:b64(p)}}
//
// and posts it as a single form field `LoginInfo`, alongside the antiforgery
// token and a `DeviceId` lifted from localStorage. b64EncodeUnicode there is
// btoa(encodeURIComponent(x)) — plain UTF-8 base64.
//
// MFA is human-in-the-loop and nothing here bypasses it: when the portal
// challenges, `login()` raises MfaRequiredError, the caller asks the human which
// channel to use, the portal sends THEM a code, and the human supplies it to
// `verifyCode`. What we persist afterwards is the `RememberDeviceId` the portal
// hands back — the same "remember this device" token a browser stores, which is
// what lets later logins skip the challenge.

import { McpToolError } from '@chrischall/mcp-utils';

export const BASE = 'https://my.atriumhealth.org/myatriumhealth';

/** Persisted device-trust record. The password is NEVER stored. */
export interface DeviceRecord extends Record<string, unknown> {
  deviceId: string;
  username: string;
  savedAt: number;
  /**
   * The cookie jar, persisted alongside the device token.
   *
   * A browser is not re-challenged partly because it KEEPS its cookies; a fresh
   * Node process starts empty and looks like a brand-new client every time.
   * Persisting the jar is what lets a restart resume the existing session
   * instead of logging in again.
   */
  cookies?: [string, string][];
}

export interface StateLike {
  load(): DeviceRecord | null;
  save(rec: DeviceRecord): void;
}

/** Delivery channels the portal offers, mapped to its own field names. */
export const DELIVERY_METHODS = {
  sms: 'deliveryMethodSMS',
  email: 'deliveryMethodEmail',
  /**
   * An authenticator app. There is nothing to SEND — the user reads the code
   * from their app — so this has no SendCode field and is verify-only.
   */
  totp: null,
} as const;
export type DeliveryMethod = keyof typeof DELIVERY_METHODS;

/**
 * The portal is challenging for a second factor. Carries the channels the human
 * can choose from — this is a prompt for input, not a failure to work around.
 */
export class MfaRequiredError extends McpToolError {
  constructor(
    readonly methods: DeliveryMethod[],
    readonly destinations: { email?: string; phone?: string } = {},
  ) {
    const where = [
      destinations.phone !== undefined ? `sms/${destinations.phone}` : null,
      destinations.email !== undefined ? `email/${destinations.email}` : null,
    ].filter((x): x is string => x !== null);
    super('MyAtriumHealth requires a verification code before this session can be used.', {
      hint:
        `Ask the user which channel to use (${methods.join(', ')}${
          where.length > 0 ? ` — ${where.join(', ')}` : ''
        }), call mah_send_verification_code, then pass the code they receive to mah_verify_code.`,
    });
    this.name = 'MfaRequiredError';
  }
}


/** What the challenge page says this account can actually do. */
export interface ChallengeContext {
  channels: DeliveryMethod[];
  /** Masked destinations the portal shows the user, e.g. "***-***-6609". */
  displayEmail?: string;
  displayPhone?: string;
  /**
   * Epic's workflow discriminator. SendCode is REFUSED without it — this is
   * why a request that looked correct came back Success:false.
   */
  workflow?: number;
  rememberMeEnabled: boolean;
  enrollDeviceTracking: boolean;
}

/**
 * Read the challenge page's embedded `templateContext`.
 *
 * It is a JavaScript literal with unquoted keys and .NET-style `True`/`False`,
 * so `JSON.parse` cannot be used; fields are extracted individually, which also
 * degrades gracefully when Epic adds or renames neighbouring settings.
 */
export function parseChallengeContext(html: string): ChallengeContext | null {
  const block = /TwoFactorSettings\s*:\s*\{([\s\S]{0,900}?)\}/.exec(html);
  if (!block) return null;
  const tfs = block[1] as string;
  const flag = (name: string, src: string): boolean =>
    new RegExp(`${name}\\s*:\\s*True\\b`, 'i').test(src);
  const str = (name: string): string | undefined =>
    new RegExp(`${name}\\s*:\\s*"([^"]*)"`).exec(tfs)?.[1];

  const channels: DeliveryMethod[] = [];
  if (flag('AllowSMS', tfs)) channels.push('sms');
  if (flag('AllowEmail', tfs)) channels.push('email');
  if (flag('AllowTotp', tfs)) channels.push('totp');

  const rm = /RememberMeSettings\s*:\s*\{([\s\S]{0,300}?)\}/.exec(html)?.[1] ?? '';
  const workflow = /Workflow\s*:\s*(\d+)/.exec(tfs)?.[1];
  const email = str('DisplayEmail');
  const phone = str('DisplayPhone');

  return {
    channels,
    ...(email !== undefined ? { displayEmail: email } : {}),
    ...(phone !== undefined ? { displayPhone: phone } : {}),
    ...(workflow !== undefined ? { workflow: Number(workflow) } : {}),
    rememberMeEnabled: flag('Enabled', rm),
    enrollDeviceTracking: flag('EnrollDeviceTracking', rm),
  };
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export interface AuthOptions {
  credentials: () => { username: string; password: string };
  persistence: StateLike;
  /** Injectable for tests. Wrapped so `this` is never bound to the client. */
  fetchImpl?: typeof fetch;
}

export class MyAtriumHealthAuth {
  private readonly jar = new Map<string, string>();
  private readonly doFetch: typeof fetch;
  private readonly credentials: AuthOptions['credentials'];
  private readonly store: StateLike;
  private context: ChallengeContext | null = null;
  /** The CHALLENGE page's antiforgery token — distinct from the login page's. */
  private challengeToken: string | undefined;

  constructor(opts: AuthOptions) {
    // Restore a previous session's cookies before anything else, so the first
    // request can discover it is already signed in.
    // A receiver-safe wrapper, never the bare global: older undici throws
    // `Illegal invocation` when fetch is called with a non-global `this`.
    this.doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.credentials = opts.credentials;
    this.store = opts.persistence;
    const rec = this.store.load();
    if (rec?.username === opts.credentials().username) {
      for (const [k, v] of rec.cookies ?? []) this.jar.set(k, v);
    }
  }

  /** Persist the jar (and any device token) so a restart can resume. */
  private persist(): void {
    const { username } = this.credentials();
    const prev = this.store.load();
    this.store.save({
      deviceId: prev?.username === username ? (prev.deviceId ?? '') : '',
      username,
      savedAt: Date.now(),
      cookies: [...this.jar],
    });
  }

  /** Is the CURRENT jar already a signed-in session? Costs one cheap GET. */
  async isSignedIn(): Promise<boolean> {
    if (this.jar.size === 0) return false;
    const { res, body } = await this.request('Home');
    const loc = res.headers.get('location') ?? '';
    if (/SecondaryValidation/i.test(loc)) return false;
    if (/Authentication\/Login/i.test(loc)) return false;
    return !/<title>[^<]*Login Page/i.test(body);
  }

  /** Redact the live password out of any text before it can surface. */
  private scrub(text: string): string {
    const { password } = this.credentials();
    if (password === '') return text;
    return text.split(password).join('[redacted]');
  }

  private absorb(res: Response): void {
    const setCookies =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const i = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
  }

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Public so {@link ServerTransport} can issue requests on this jar. */
  async request(path: string, init: RequestInit = {}): Promise<{ res: Response; body: string }> {
    const res = await this.doFetch(`${BASE}/${path.replace(/^\/+/, '')}`, {
      ...init,
      redirect: 'manual',
      headers: {
        cookie: this.cookieHeader(),
        'user-agent': 'Mozilla/5.0',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    this.absorb(res);
    return { res, body: await res.text() };
  }

  private async antiforgeryToken(): Promise<string> {
    const { body } = await this.request('Authentication/Login');
    const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(body);
    if (!m) {
      throw new McpToolError('Could not read the antiforgery token from the login page.', {
        hint: 'The portal markup may have changed; see docs/MYATRIUMHEALTH-API.md.',
      });
    }
    return m[1] as string;
  }

  /**
   * The challenge page's own settings. Fetched lazily and cached: `sendCode`
   * and `verifyCode` both need its `workflow`, without which the portal
   * refuses the request with a bare `Success:false`.
   */
  async challengeContext(force = false): Promise<ChallengeContext | null> {
    // The antiforgery token is single-use-ish: an intervening POST (a failed
    // DeviceCheck, say) invalidates it, and reusing a stale one makes the
    // handler 500 — which surfaces as a bare Success:false and reads like
    // "this channel is not configured". Always refresh before a challenge POST.
    if (!force && this.context !== null) return this.context;
    const { body } = await this.request('Authentication/SecondaryValidation?ranDeviceCheck=1');
    this.context = parseChallengeContext(body);
    this.challengeToken = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(body)?.[1];
    return this.context;
  }

  /**
   * Headers for the SecondaryValidation POSTs. Omitting the antiforgery token
   * does not yield a polite refusal — the handler 500s and redirects to
   * /Home/FiveHundred, which parses as `Success:false` and reads exactly like
   * "this channel is not configured on the account".
   */
  private challengeHeaders(): Record<string, string> {
    return {
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      ...(this.challengeToken !== undefined
        ? { __RequestVerificationToken: this.challengeToken }
        : {}),
    };
  }

  /** The stored device-trust token for the CURRENT account, if any. */
  deviceId(): string | undefined {
    const rec = this.store.load();
    const { username } = this.credentials();
    return rec && rec.username === username ? rec.deviceId : undefined;
  }

  /**
   * Log in server-side. Resolves when a session is established; raises
   * {@link MfaRequiredError} when the portal wants a verification code.
   */
  async login(): Promise<{ signedIn: true; usedDeviceId: boolean }> {
    const { username, password } = this.credentials();
    const token = await this.antiforgeryToken();
    const device = this.deviceId();

    const form = new URLSearchParams();
    form.set('__RequestVerificationToken', token);
    form.set(
      'LoginInfo',
      JSON.stringify({
        Type: 'StandardLogin',
        Credentials: { LoginIdentifier: b64(username), Password: b64(password) },
      }),
    );
    // DELIBERATELY NOT SENT. The RememberDeviceId this portal returns is not a
    // device-tracking id it will accept back: including it does not skip
    // verification AND it breaks the challenge — the SecondaryValidation page
    // then renders without its templateContext, so the antiforgery token cannot
    // be read and SendCode 500s. Measured both ways, repeatedly. The account
    // reports RememberMeSettings.EnrollDeviceTracking:False, which fits.
    // Session continuity comes from the persisted cookie jar instead.
    void device;

    const { res, body } = await this.request('Authentication/Login/DoLogin', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        __RequestVerificationToken: token,
      },
      body: form.toString(),
    });

    if (res.status >= 500) {
      throw new McpToolError(
        `MyAtriumHealth login failed upstream (${res.status}): ${this.scrub(body).slice(0, 200)}`,
      );
    }

    const location = res.headers.get('location') ?? '';
    // A rejected credential comes back with an explicit error marker. Do NOT
    // retry it: the login controller can switch on hCaptcha/reCAPTCHA, and
    // repeated failures escalate to a lockout that breaks every auth path.
    if (/error=/i.test(location) || /genericloginfailed/i.test(location)) {
      throw new McpToolError('MyAtriumHealth rejected the credentials.', {
        hint:
          'Check MAH_USERNAME / MAH_PASSWORD. Do not retry repeatedly — the portal ' +
          'escalates to a captcha or lockout after repeated failures.',
      });
    }

    const landing = await this.request('Home');
    const nextLocation = landing.res.headers.get('location') ?? '';
    if (/SecondaryValidation/i.test(nextLocation) || /SecondaryValidation/i.test(landing.body)) {
      // NOTE: do NOT post SecondaryValidation/DeviceCheck here. Replicating the
      // browser's device-check call does not redeem trust for a server-side
      // session, and it POISONS the challenge: afterwards the page stops
      // rendering its templateContext, so the antiforgery token cannot be read
      // and SendCode 500s. Measured directly — with a stored device token the
      // context failed to parse and SendCode returned 500; without one it
      // parsed and returned Success:true.
      const ctx = await this.challengeContext();
      throw new MfaRequiredError(ctx?.channels ?? ['sms', 'email'], {
        ...(ctx?.displayEmail !== undefined ? { email: ctx.displayEmail } : {}),
        ...(ctx?.displayPhone !== undefined ? { phone: ctx.displayPhone } : {}),
      });
    }
    return { signedIn: true, usedDeviceId: device !== undefined };
  }

  /** Ask the portal to send the human a verification code. */
  async sendCode(method: DeliveryMethod, resend = false): Promise<{ sent: true }> {
    const field = DELIVERY_METHODS[method];
    if (field === null) {
      throw new McpToolError('An authenticator app code is not sent by the portal.', {
        hint: 'Read the current code from your authenticator app and pass it to mah_verify_code.',
      });
    }
    const ctx = await this.challengeContext(true);
    const form = new URLSearchParams();
    form.set(field, 'true');
    form.set('resendCode', String(resend));
    // Load-bearing: without `workflow` the portal answers Success:false with no
    // explanation, which reads exactly like "this channel is not configured".
    if (ctx?.workflow !== undefined) form.set('workflow', String(ctx.workflow));
    if (this.challengeToken !== undefined) form.set('__RequestVerificationToken', this.challengeToken);
    const { body } = await this.request('Authentication/SecondaryValidation/SendCode', {
      method: 'POST',
      headers: this.challengeHeaders(),
      body: form.toString(),
    });
    let ok = false;
    try {
      ok = (JSON.parse(body) as { Success?: boolean }).Success === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new McpToolError(`MyAtriumHealth would not send a code via ${method}.`, {
        hint: 'That channel may not be configured on the account; try another.',
      });
    }
    return { sent: true };
  }

  /**
   * Submit the code the human received. On success the portal returns a
   * `RememberDeviceId`, which is persisted so later logins skip the challenge.
   */
  async verifyCode(code: string, rememberDevice = true): Promise<{ remembered: boolean }> {
    await this.challengeContext(true);
    const form = new URLSearchParams();
    form.set('TwoFactorCode', code);
    form.set('RememberMe', rememberDevice ? 'checked' : '');
    const ctx = this.context;
    form.set(
      'EnrollDeviceTrackingOnRemember',
      String(rememberDevice && (ctx?.enrollDeviceTracking ?? false)),
    );
    if (ctx?.workflow !== undefined) form.set('Workflow', String(ctx.workflow));
    const existing = this.deviceId();
    if (existing !== undefined) form.set('DeviceId', existing);

    if (this.challengeToken !== undefined) form.set('__RequestVerificationToken', this.challengeToken);
    const { body } = await this.request('Authentication/SecondaryValidation/Validate', {
      method: 'POST',
      headers: this.challengeHeaders(),
      body: form.toString(),
    });

    let parsed: { Success?: boolean; RememberDeviceId?: string } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (parsed.Success !== true) {
      throw new McpToolError('MyAtriumHealth rejected the verification code.', {
        hint: 'Codes are short-lived and single-use. Request a new one and try again.',
      });
    }

    const id = parsed.RememberDeviceId;
    const { username } = this.credentials();
    // Persist the jar either way: the session established by verifying is worth
    // keeping even if the device token turns out not to be honoured.
    this.store.save({
      deviceId: rememberDevice && typeof id === 'string' ? id : '',
      username,
      savedAt: Date.now(),
      cookies: [...this.jar],
    });
    return { remembered: rememberDevice && typeof id === 'string' && id !== '' };
  }
}
