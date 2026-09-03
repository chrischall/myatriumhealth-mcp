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

## Message list — body captured, shell replay NOT yet working

`POST api/conversations/GetConversationList` needs a 5-key body (captured live from the app):

    {"tag": 1,
     "localLoadParams": {"loadStartInstantISO":"", "loadEndInstantISO":"", "pagingInfo":1},
     "externalLoadParams": {"<orgHandle>": {"communicationCenter": {…same three fields…}}},
     "searchQuery": "",
     "PageNonce": "<32-hex CSP nonce>"}

`tag` selects the folder, from `GetFoldersList`: 1 = Conversations/inbox, 2 = Archive,
3, 6, 7 = Bookmarked / Appointments / Automated (exact mapping unconfirmed).

**Status:** replaying the app's exact captured body in-page returns 200. Reconstructing
it from the shell has not yet succeeded — omitting or emptying `externalLoadParams`
returns 500, and the org handles taken from the *visits* response (3) do not match the
communication-center set (2). The remaining unknown is where the correct handle set
comes from. `api/item-feed/FetchItemFeed` is in the same category.

Do NOT try to satisfy this by generating nonce values — the nonce is an anti-CSRF
control; read the one the server sent.
