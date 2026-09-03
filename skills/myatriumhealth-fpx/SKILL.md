---
name: myatriumhealth-fpx
description: >-
  Read MyAtriumHealth (Atrium Health's Epic MyChart patient portal) — test
  results, medications, allergies, immunizations, health issues, visits, goals
  — from a shell with the fpx CLI (@fetchproxy/cli), by relaying requests
  through your signed-in Chrome tab. Use when you want your MyChart data in a
  script or one-shot without running the myatriumhealth-mcp server.
---

# MyAtriumHealth via fpx

Atrium Health's patient portal is Epic MyChart at `my.atriumhealth.org`. Its web app
talks to a clean JSON API, and this skill drives that same API through your signed-in
browser tab.

**Why the browser is required:** every MyChart cookie is `HttpOnly`, so the session
cannot be read or reproduced outside the browser, and login is MFA-gated. Requests are
relayed through the tab; the session cookie is never extracted or stored.

This reads personal health information. It only ever touches the signed-in user's own
account.

## One-time setup

    npm i -g @fetchproxy/cli          # also needs the Transporter Chrome extension

Create the profile with its **full scope declared up front** — widening scope later
invalidates the grant and forces a re-pair:

    fpx profile add myatriumhealth --domain atriumhealth.org
    fpx profile declare myatriumhealth \
      --cookie '_Host-MyChart_Session' \
      --cookie '__RequestVerificationToken_L215YXRyaXVtaGVhbHRo0' \
      --cookie '_Host-MyChartLocale' --cookie 'MYCPERS' --cookie 'p-MYC-LBPersistence' \
      --capture-header 'cookie@my.atriumhealth.org'

Then sign in to MyAtriumHealth in Chrome and run any command below. The first one
prints a pair code — approve it in the Transporter popup. The trust persists.

## Use it

    source references/mah.sh
    mah_signed_in || echo "sign in to MyAtriumHealth in Chrome first"
    export MAH_TOKEN="$(mah_token)"      # cache once per shell

    mah_api allergies/LoadAllergies | jq '[.dataList[].allergyItem | {name, severe: .isSevere}]'

`mah_api <area/Action> [json-body]` posts to the modern `api/…` endpoints (body
defaults to `{}`, which is all most of them need). `mah_legacy <Area/Controller/Action>
[querystring]` handles the older form-encoded ones (visits).

Every call needs the ASP.NET antiforgery token — `mah_token` scrapes it from a
signed-in page and the helpers attach it. Responses are large (test results 33 KB,
medications 30 KB); always project with `jq`.

**See `references/endpoints.md`** for the full endpoint list with ready-to-run,
live-verified `jq` recipes, and `references/mah.sh` for the helpers.

## Check the session, not the status code

MyChart answers an **expired session with HTTP 200 whose body is the login page**, and
the JSON endpoints then quietly return `{}`. A status check would report success
forever. `mah_signed_in` tests the body — use it when results come back empty. Sessions
are short-lived; expect to sign in again between uses.

## Exit codes (fpx)

`0` ok · `1` usage · `2` bridge unavailable (extension not connected, or pairing not
approved) · `3` bot wall · `4` upstream HTTP error.

Data goes to stdout, pair codes and status to stderr — so `| jq` stays clean.

## Known gap

The message list (`api/conversations/GetConversationList`) is not yet reachable from
the shell; it needs a page nonce plus organization handles that have not been pinned
down. `references/endpoints.md` documents exactly what is known. Do not try to satisfy
the nonce by generating values — it is an anti-CSRF control; read the one the server
sent (`mah_nonce`).
