# MyAtriumHealth (Epic MyChart) — internal web API

Captured live 2026-09-03 against `my.atriumhealth.org` (Epic **February 2026** build)
while signed in. Request shapes below were exercised end-to-end unless marked otherwise.
**No credentials, cookies, tokens or patient data are recorded in this file.**

## Transport

Base: `https://my.atriumhealth.org/myatriumhealth`

Two generations of endpoint coexist:

| Style | Example | Body |
|---|---|---|
| Modern | `POST api/<area>/<Action>` | JSON (`{}` for most) |
| Legacy MVC | `POST <Area>/<Controller>/<Action>?ComponentNumber=N&noCache=<rand>` | form-encoded, empty |

All return `application/json`. All require the ASP.NET antiforgery token.

### Auth

Every cookie is **HttpOnly** (`document.cookie` is empty), so the session cannot be
read from page JS. Cookies set by the server:

- `_Host-MyChart_Session` — the session (note: single leading underscore, *not* `__Host-`)
- `__RequestVerificationToken_L215YXRyaXVtaGVhbHRo0` — antiforgery cookie
- `_Host-MyChartLocale`, `MYCPERS`, `p-MYC-LBPersistence`

Requests need the antiforgery token as a **header** `__RequestVerificationToken`, whose
value is the 172-char hidden input on any signed-in page:

    <input name="__RequestVerificationToken" value="...">

Headers the app itself sends (captured): `__requestverificationtoken`, `accept:
application/json`, `content-type: application/json`. It does **not** send
`X-Requested-With`.

### Session expiry is a 200, not a 401

An expired session returns **HTTP 200 whose body is the login page HTML**, and the
JSON endpoints then return `{}` / `""` rather than an error. Detect by checking the
fetched HTML for `<title>MyAtriumHealth - Login Page</title>` — never by status code.
Sessions are short-lived; assume re-login between uses.

An **empty** body is a different failure with the same surface symptom: fetchproxy runs
requests inside a tab on the target host, so with no my.atriumhealth.org tab open it
relays nothing. Empty text contains no login marker, so a login-page check alone reports
"signed in" for a response that never happened — test for emptiness FIRST.

### PageNonce (needed by a minority of endpoints)

From the shipped bundle (`bundles/core-1-post`):

    $$WPUtil.GetPageNonce = function () {
      var t = document.getElementById("cspScripts");
      return t ? (t.nonce || t.getAttribute("nonce")) : "";
    }

It is the page's **CSP script nonce** — a 32-char hex value delivered in the HTML as
`<script id='cspScripts' nonce='...'>` (**single quotes** — a double-quote-only regex
misses it). Note browsers hide `nonce` from DOM serialization, so it is invisible to
`outerHTML`/`getAttribute` in a live page but present in the raw server response.
Only the `/app/*` SPA pages carry one; `/Home` and `/Messaging` do not.

## Endpoints verified working (empty `{}` body, no nonce)

| Endpoint | Response top-level keys |
|---|---|
| `api/test-results/GetList` | `newResults`, `newResultGroups`, `newComments`, `groupBy`, `organizationLoadMoreInfo`, `areResultsFullyLoaded` |
| `api/medications/LoadMedicationsPage` | `communityMembers`, `medSettings`, `medicationsUrl`, `isProxyView`, `getPatientFirstName` |
| `api/allergies/LoadAllergies` | `dataList`, `dateOfBirth`, `allergiesStatus`, `hasUpdateSecurity` |
| `api/immunizations/LoadImmunizations` | `organizationImmunizationList`, `showPersonalNotes`, `immunizationsUrl` |
| `api/HealthIssues/LoadHealthIssuesData` | `dataList`, `hasUpdateSecurity`, `alwaysShowSearchMore` |
| `api/health-summary/FetchHealthSummary` | `header`, `actionPlans`, `patientFirstName`, `isPatientAdmitted` |
| `api/goals/LoadPatientGoals` | `patientGoals`, `hasChartGraphSecurity`, `quickLinkDictionary` |
| `api/conversations/GetFoldersList` | `folders[] {tag, badgeCount, totalCount}` |
| `api/search/LoadMenuInfo` | `submenus[]`, `shortcuts[]`, `menuItemDictionary` |
| `api/test-results/GetWidgetList`, `GetResultsReleasePreferences`, `GetCommunityInfo` | — |
| `api/immunizations/…`, `api/wound/GetWounds`, `api/education/GetPatEducationTitles` | — |

Legacy visit endpoints (form-encoded, empty body):

- `Visits/VisitsList/LoadUpcoming?timeZone=<TZ>&ComponentNumber=5`
  → `{LaterVisitsList, NextNDaysVisits, InProgressVisits, HighlightDays, HasPVG}`
- `Visits/VisitsList/LoadPast?loadpast=1&searchString=&oldestRenderedDate=<ISO>&ComponentNumber=7`
  → `{List: {<orgHandle>: {Organization{…}, List[] {Csn, PrimaryDate, PastVisitBucket,
     IsNotViewed, ShowVisitDetails, …}, ListSize, HasMoreData}}, SerializedIndex}`
- `Visits/VisitsList/LoadAppointmentRequest`, `VisitsHeaderOptions`, `GetHomeOrganizationIdAndName`

`api/conversations/GetOrganizations` returns the "Oops!" error page for `{}` — it needs
parameters that have not been captured.

## Message list — working

`POST api/conversations/GetConversationList` needs a five-key body (captured live from
the app, then reproduced from the shell and the MCP):

    {"tag":1,
     "localLoadParams":{"loadStartInstantISO":"","loadEndInstantISO":"","pagingInfo":1},
     "externalLoadParams":{"<external org handle>":{"communicationCenter":{…same three…}}},
     "searchQuery":"",
     "PageNonce":"<32-hex CSP nonce from an /app/* page>"}

`tag` selects the folder, from `GetFoldersList`: 1 = Conversations/inbox, 2 = Archive,
3, 6, 7 = Bookmarked / Appointments / Automated (exact mapping unconfirmed).

**The organization handles were the hard part.** `externalLoadParams` takes the
NON-LOCAL organizations only. Get them from `api/conversations/GetOrganizations` — which
DOES accept `{}` (an earlier note here said otherwise; that failure was a stale session,
not a missing parameter) — and filter on the explicit `isLocal` flag. Passing the local
organization, or the handles from the visits response (which include it), returns
HTTP 500. Each org also carries `hasCommunicationCenter`, `hasInbox`, `hasOutbox`,
`hasDrafts`, `organizationName`.

Response: `{conversations[], users, viewers, localSummary, externalSummaries,
legacyXUnreadCount}`. A conversation has `subject`, `previewText`, `messageType`,
`hasAttachments`, `hasUrgentMsgs`, `hasTasks`, `organizationId`, `userKeys`, `tags` and
`messages[]` → `{author, body, deliveryInstantISO, isUnread, attachments,
suggestedActions, tasks, wmgId}`.

Verified: inbox (tag 1) returned 18 conversations and Archive (tag 2) returned 1,
matching the `totalCount` values `GetFoldersList` reports for those tags.

Do NOT try to satisfy the nonce by generating values — it is an anti-CSRF control;
read the one the server sent.

`api/item-feed/FetchItemFeed` still needs parameters that have not been captured.
