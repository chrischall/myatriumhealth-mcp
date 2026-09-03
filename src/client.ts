// MyAtriumHealth (Epic MyChart) client.
//
// Every MyChart cookie is HttpOnly and login is MFA-gated, so the session
// cannot be reproduced outside the browser: requests are relayed through the
// user's signed-in tab. This client never sees or stores the session cookie.
//
// Two endpoint generations coexist (see docs/MYATRIUMHEALTH-API.md):
//   modern  POST api/<area>/<Action>          JSON body, `{}` for most
//   legacy  POST <Area>/<Controller>/<Action> form-encoded, empty body
// Both require the ASP.NET antiforgery token scraped from a signed-in page.

import { McpToolError } from '@chrischall/mcp-utils';
import type { FetchInit, FetchResult, MahTransport } from './transport.js';

/** Path under the app root that reliably renders for a signed-in user. */
const TOKEN_PAGE = 'Home';

const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;
// The CSP nonce is SINGLE-quoted in Epic's markup; accept either quoting.
const NONCE_RE =
  /id=['"]cspScripts['"][^>]*nonce=['"]([0-9a-f]{32})['"]/;

/**
 * MyChart answers an EXPIRED session with HTTP 200 whose body is the login
 * page — never a 401 — and the JSON endpoints then return `{}`. Detecting this
 * by status code would report success forever, so detect it by content.
 *
 * This deployment also has two-factor authentication enabled (the shipped
 * resources include EnableTwoFactorAuthentication / ContinueTwoFactorFormButton),
 * so a session can in principle be interrupted by a verification step-up rather
 * than a plain login page. The MCP never authenticates — the human completes
 * MFA in the browser — but it must not MISREPORT such an interstitial as a
 * broken endpoint, which is what a login-page-only check does.
 *
 * The exact step-up markup has NOT been observed: triggering a real MFA
 * challenge to capture it would mean repeated auth attempts against a live
 * health account, which is how these systems escalate. The markers below are
 * therefore deliberately broad, and the generic HTML fallback in `parse` names
 * authentication as a possible cause regardless.
 */
function isAuthWall(html: string): boolean {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  if (/Login Page/i.test(title)) return true;
  // Title-scoped on purpose. Matching `twoFactor` anywhere in the BODY looks
  // right and is catastrophically wrong: every signed-in page links to
  // two-factor setup under Settings, so a body-wide match reports "not signed
  // in" for every request. Verified against a real signed-in Home page, which
  // contains both `twoFactor` and `two-factor` while being perfectly valid.
  if (/verify|verification|two[- ]?factor/i.test(title)) return true;
  return /name=["']verificationCode["']/i.test(html);
}

/**
 * An empty body means the bridge relayed nothing — almost always no signed-in
 * my.atriumhealth.org tab is open, since fetchproxy runs the request INSIDE a
 * tab on the target host. Reporting this as "did not return JSON" points people
 * at the endpoint when the fix is in their browser. Worse, a naive
 * "is this the login page?" check treats an empty body as signed-in, because
 * the login marker is absent from empty text as surely as from a real page.
 */
function emptyBody(what: string): McpToolError {
  return new McpToolError(
    `MyAtriumHealth returned an empty response for ${what} — the browser bridge relayed nothing.`,
    {
      hint:
        'Open https://my.atriumhealth.org/ in a Chrome tab and sign in, then retry. ' +
        'fetchproxy issues requests from inside that tab, so it needs one open on the site.',
    },
  );
}

function notSignedIn(): McpToolError {
  return new McpToolError(
    'Not signed in to MyAtriumHealth — the portal returned a sign-in or verification page.',
    {
      hint:
        'Open https://my.atriumhealth.org/ in Chrome and sign in, completing any ' +
        'verification prompt, then retry. MyChart sessions are short-lived, so this ' +
        'recurs between uses.',
    },
  );
}

export interface MyAtriumHealthClientOptions {
  transport: MahTransport;
}

export class MyAtriumHealthClient {
  private readonly transport: MahTransport;
  /** Cached antiforgery token — one page fetch per process, not per request. */
  private token: string | undefined;
  private inFlightToken: Promise<string> | undefined;

  constructor(opts: MyAtriumHealthClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Fetch a page under the app root, rejecting an expired session. */
  async page(path: string): Promise<string> {
    const res: FetchResult = await this.transport.fetch({
      method: 'GET',
      path: path.replace(/^\/+/, ''),
    });
    if (res.body.trim() === '') throw emptyBody(path);
    if (isAuthWall(res.body)) throw notSignedIn();
    return res.body;
  }

  /**
   * The antiforgery token, cached. Concurrent callers share one page fetch —
   * a burst of tool calls must not each pull a 137 KB page.
   */
  async getToken(): Promise<string> {
    if (this.token !== undefined) return this.token;
    this.inFlightToken ??= (async () => {
      try {
        const html = await this.page(TOKEN_PAGE);
        const m = TOKEN_RE.exec(html);
        if (!m) {
          throw new McpToolError(
            'Could not find the antiforgery token on a signed-in MyAtriumHealth page.',
            { hint: 'The portal markup may have changed; see docs/MYATRIUMHEALTH-API.md.' },
          );
        }
        this.token = m[1] as string;
        return this.token;
      } finally {
        this.inFlightToken = undefined;
      }
    })();
    return this.inFlightToken;
  }

  /**
   * The page CSP nonce ($$WPUtil.GetPageNonce), required by the conversations
   * endpoints. Only `/app/*` SPA pages carry one.
   */
  async pageNonce(path = 'app/communication-center'): Promise<string> {
    const html = await this.page(path);
    const m = NONCE_RE.exec(html);
    if (!m) {
      throw new McpToolError(`No CSP nonce on ${path}.`, {
        hint: 'Only /app/* SPA pages carry a nonce.',
      });
    }
    return m[1] as string;
  }

  /** Parse a JSON response, turning an HTML error page into a real error. */
  private parse<T>(body: string, endpoint: string): T {
    const trimmed = body.trimStart();
    if (trimmed === '') throw emptyBody(endpoint);
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      if (isAuthWall(body)) throw notSignedIn();
      const oops = /<title>([^<]*)</.exec(body)?.[1]?.trim();
      throw new McpToolError(
        `${endpoint} did not return JSON${oops ? ` — the portal returned "${oops}"` : ''}.`,
        {
          // Two very different causes surface identically as non-JSON HTML: a
          // missing parameter, and an authentication or verification
          // interstitial. Naming only the first sends people to debug the
          // endpoint when the fix is in their browser.
          hint:
            'Either the endpoint needs parameters that have not been captured ' +
            '(see docs/MYATRIUMHEALTH-API.md), or the portal is showing a sign-in or ' +
            'verification page — open https://my.atriumhealth.org/ in Chrome and check.',
        },
      );
    }
    return JSON.parse(body) as T;
  }

  private async send<T>(init: FetchInit, endpoint: string): Promise<T> {
    const res = await this.transport.fetch(init);
    return this.parse<T>(res.body, endpoint);
  }

  /** POST a modern `api/<area>/<Action>` endpoint. Body defaults to `{}`. */
  async api<T = unknown>(endpoint: string, body: unknown = {}): Promise<T> {
    const token = await this.getToken();
    return this.send<T>(
      {
        method: 'POST',
        path: `api/${endpoint.replace(/^\/+/, '')}`,
        headers: {
          __RequestVerificationToken: token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      endpoint,
    );
  }

  /**
   * List Message Center conversations for a folder tag.
   *
   * This endpoint is fussier than the rest and every part was established by
   * capturing the app's own request:
   *  - it needs FIVE keys; omitting `searchQuery` or `PageNonce` fails,
   *  - `PageNonce` is the CSP nonce of an `/app/*` page (see {@link pageNonce}),
   *  - `externalLoadParams` must contain the NON-local organizations only.
   *    Passing the local org (or organization handles taken from the visits
   *    response, which include it) returns HTTP 500.
   */
  async listConversations(tag = 1): Promise<unknown> {
    const [orgsRes, nonce] = await Promise.all([
      this.api<{ organizations?: Record<string, { isLocal?: boolean }> }>(
        'conversations/GetOrganizations',
      ),
      this.pageNonce(),
    ]);
    const load = { loadStartInstantISO: '', loadEndInstantISO: '', pagingInfo: 1 };
    const externalLoadParams: Record<string, { communicationCenter: typeof load }> = {};
    for (const [handle, org] of Object.entries(orgsRes.organizations ?? {})) {
      if (org?.isLocal !== true) externalLoadParams[handle] = { communicationCenter: { ...load } };
    }
    return this.api('conversations/GetConversationList', {
      tag,
      localLoadParams: { ...load },
      externalLoadParams,
      searchQuery: '',
      PageNonce: nonce,
    });
  }

  /**
   * Care team providers. The page issues TWO calls — `Load` for providers at
   * this organization and `LoadExternal` for those at linked outside ones — and
   * shows the union, so a single tool must too.
   */
  async careTeam(): Promise<{ internal: unknown; external: unknown }> {
    const common = { hfrId: '', sources: '', actions: '', ComponentNumber: '2' };
    const [internal, external] = await Promise.all([
      this.legacy('Clinical/CareTeam/Load', { ...common, isPrimaryStandalone: 'true' }),
      this.legacy('Clinical/CareTeam/LoadExternal', { ...common }),
    ]);
    return { internal, external };
  }

  /** POST a legacy form-encoded endpoint, with the cache-buster Epic expects. */
  async legacy<T = unknown>(
    path: string,
    query: Record<string, string> = {},
    form: Record<string, string> = {},
  ): Promise<T> {
    const token = await this.getToken();
    const qs = new URLSearchParams({
      ...query,
      noCache: String(Math.random()),
    }).toString();
    return this.send<T>(
      {
        method: 'POST',
        path: `${path.replace(/^\/+/, '')}?${qs}`,
        headers: {
          __RequestVerificationToken: token,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      },
      path,
    );
  }
}
