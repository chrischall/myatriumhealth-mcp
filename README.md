# myatriumhealth-mcp

MCP server for **MyAtriumHealth** — Atrium Health's [Epic MyChart](https://www.mychart.com/)
patient portal at `my.atriumhealth.org`. Reads test results, medications, allergies,
immunizations, health issues, goals and visits.

> This project was developed and is maintained by AI. Use at your own discretion.
> It reads personal health information, and only ever from the signed-in user's own account.

## Two ways to authenticate

| Mode | When | Credentials held |
|---|---|---|
| **Browser bridge** (default) | no credentials configured | **none** |
| **Bridge-less** | `MAH_USERNAME` + `MAH_PASSWORD` set | your portal password, on disk |

Bridge-less logs in server-side — no browser, no extension — which is what makes
hosting possible. Verification is **human-in-the-loop**: the portal challenges,
`mah_sign_in` reports the channels your account allows, the portal sends a code to
**you**, and `mah_verify_code` submits only what you provide. Nothing here bypasses the
second factor.

**When the session expires** you do *not* reconnect the MCP or restart anything. The
next tool call returns an actionable error naming the channels and your masked
destinations; you pick one, the portal texts or emails **you**, and `mah_verify_code`
resumes the session in place. A pending challenge is remembered, so further tool calls
report it rather than re-submitting your password each time.

**How the session persists.** After one verification the cookie jar is stored (0600,
bound to the account) and reused, so restarts resume the existing session rather than
signing in again — no browser and no further codes until the session lapses.

> **What does NOT work, measured rather than assumed:** the `RememberDeviceId` this
> portal returns is *not* a device-tracking id it will accept back. Sending it neither
> skips verification nor is harmless — it breaks the challenge, leaving the
> SecondaryValidation page without its `templateContext` so the antiforgery token
> cannot be read and `SendCode` returns 500. The account reports
> `RememberMeSettings.EnrollDeviceTracking: False`, which fits. The token is therefore
> stored but deliberately never sent.

The bridge mode's real virtue is that it holds **no credentials at all**. Prefer it
unless you specifically need bridge-less.

## How it works

Every MyChart cookie is `HttpOnly` and login is MFA-gated, so the session cannot be
copied out of the browser and replayed from Node. Requests are therefore relayed
through the user's own signed-in tab via the
[fetchproxy](https://github.com/chrischall/fetchproxy) bridge and the Transporter
extension, reusing their authenticated session. **The server never reads or stores the
session cookie.**

The portal's web app talks to a JSON API in two generations — modern
`POST api/<area>/<Action>` and legacy form-encoded `POST <Area>/<Controller>/<Action>`.
Both are documented, with live-captured shapes, in
[`docs/MYATRIUMHEALTH-API.md`](docs/MYATRIUMHEALTH-API.md).

## Install

```jsonc
{
  "mcpServers": {
    "myatriumhealth": {
      "command": "npx",
      "args": ["-y", "@chrischall/myatriumhealth-mcp"]
    }
  }
}
```

Then sign in to `my.atriumhealth.org` in Chrome and call `mah_healthcheck`. The first
call prints a pair code — approve it once in the Transporter popup.

| Env | Default | Purpose |
|---|---|---|
| `MAH_USERNAME` | — | MyAtriumHealth username. Set **with** `MAH_PASSWORD` to enable bridge-less mode. |
| `MAH_PASSWORD` | — | Portal password. Both are required; setting only one falls back to the bridge (with a warning). |
| `MAH_DEVICE_FILE` | `~/.myatriumhealth-mcp/device.json` | Session state (0600). Holds the **live cookie jar** as well as the device token — treat as a credential. |
| `MAH_WS_PORT` | `37149` | fetchproxy concentrator port (bridge mode only). The whole fleet shares this one port; override only when hosting. |

## Tools

All read-only — this surface exposes no writes.

| Tool | What it returns |
|---|---|
| `mah_list_allergies` | Allergies with reactions and severity |
| `mah_list_health_issues` | The problem list |
| `mah_list_immunizations` | Immunizations and dates, by organization |
| `mah_list_medications` | Medications with dosing instructions (sig) and prescriber |
| `mah_list_test_results` | Labs and imaging: name, abnormal flag, date, provider comments |
| `mah_list_upcoming_visits` | Upcoming and in-progress appointments |
| `mah_list_past_visits` | Past visits, grouped by organization |
| `mah_list_goals` | Patient goals |
| `mah_get_health_summary` | Health-summary header and action plans |
| `mah_list_message_folders` | Message Center folders with unread counts |
| `mah_list_messages` | Message Center conversations for a folder |
| `mah_list_insurance` | Insurance coverages on file |
| `mah_list_care_team` | Care team providers, internal and external |
| `mah_list_billing_accounts` | Billing accounts and balances (parsed from HTML) |
| `mah_get_menu` | Which portal features this account exposes |
| `mah_healthcheck` | Connection health — bridge status, or credential/session status in bridge-less mode |
| `mah_auth_status` | Whether a session can be resumed and whether a device token is stored *(bridge-less only)* |
| `mah_sign_in` | Sign in server-side; reports verification channels if a code is needed *(bridge-less only)* |
| `mah_send_verification_code` | Ask the portal to send a code to the account holder *(bridge-less only)* |
| `mah_verify_code` | Submit the code the user received *(bridge-less only)* |

Listing tools take `compact` (default `false`). The raw envelopes are large — test
results ~33 KB, medications ~30 KB — so pass `compact: true` when browsing. If the
portal's shape drifts, the projection warns to stderr and returns the raw response
rather than an empty list.

## Sessions expire, and they do it quietly

MyChart answers an **expired session with HTTP 200 whose body is the login page**, never
a 401, and the JSON endpoints then return `{}`. Tools raise a "Not signed in" error with
the remedy rather than reporting empty results. Sessions are short-lived; expect to sign
in again between uses.

## Without the MCP

[`skills/myatriumhealth-fpx`](skills/myatriumhealth-fpx) does the same thing from a
shell with the `fpx` CLI — no server to run. Its `references/endpoints.md` carries
live-verified `jq` recipes for every endpoint here.

## Messages

`mah_list_messages` is the one endpoint that cannot be called with an empty body. It
needs a five-key request whose `PageNonce` is the CSP nonce of an `/app/*` page, and
whose `externalLoadParams` lists the **non-local** organizations only — passing the
local organization returns HTTP 500. The client assembles this from
`conversations/GetOrganizations` and its explicit `isLocal` flag.

`api/item-feed/FetchItemFeed` still needs parameters that have not been captured.

## Development

```sh
npm install
npm test          # typecheck + vitest
npm run build
```

## License

MIT
