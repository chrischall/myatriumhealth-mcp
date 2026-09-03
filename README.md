# myatriumhealth-mcp

MCP server for **MyAtriumHealth** — Atrium Health's [Epic MyChart](https://www.mychart.com/)
patient portal at `my.atriumhealth.org`. Reads test results, medications, allergies,
immunizations, health issues, goals and visits.

> This project was developed and is maintained by AI. Use at your own discretion.
> It reads personal health information, and only ever from the signed-in user's own account.

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
| `MAH_WS_PORT` | `37149` | fetchproxy concentrator port. The whole fleet shares this one port; override only when hosting. |

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
| `mah_get_menu` | Which portal features this account exposes |
| `mah_healthcheck` | Bridge health, and whether the portal session is signed in |

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
