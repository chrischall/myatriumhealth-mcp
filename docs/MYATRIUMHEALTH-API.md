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

## Insurance (legacy, form-encoded)

`POST Insurance/Coverages/GetCoverages` with the form body `isStandAlone=true`
→ `{ActiveCoverages[], CoveragesPendingSubmission[], CoveragesPendingDeletion[],
CoveragesInReview[], CoveragesInVerification[], IsProxyContext, HasExistingCoveragesInRTE,
Settings{IsStandAlone, CanUpdate, CanViewDetails, CanPayPremium, CanViewInsHub, IsInsHubOn}}`.

Parameters were read from the shipped bundle (`bundles/insurance-controllers`):

    $.post({url: P, data: {isStandAlone, encounterCsn, encounterDepartmentId, encounterDTE}})

An empty body returns the "Oops!" error page. Supplying `encounterCsn=0` narrows the
result (219 bytes vs 1189), so the encounter fields really do filter — `isStandAlone=true`
alone is the standalone-page call.

Coverage items were observed via `CoveragesInReview` (the account has zero *active*
coverages but one in review — an earlier note here wrongly concluded the item shape was
uncapturable, having only checked `ActiveCoverages`). Fields:

    BackDocument, Comments, CoverageFHIRId, CoverageId, CoverageName, CoverageType,
    CvgCoveredStatus, CvgReason, FormattedEffectiveDate, FormattedEndDate, FrontDocument,
    Future, GroupNumber, Index, IsCoverageDocumentFromPayer, MemberDateOfBirth,
    MemberFirstName, MemberId, MemberLastName, MemberName, OrganizationId,
    PatientIsSubscriber, PayorId, PayorName, PbiId, PlanName, Status,
    SubscriberDateOfBirth, SubscriberFirstName, SubscriberId, SubscriberIsSelf,
    SubscriberLastName, SubscriberName, SuspendedText, Termed

`POST Insurance/Coverages/GetPayors` (empty body) → `{Payors}`, a reference list of
insurers.

## Care team (legacy)

`POST Clinical/CareTeam/Load?hfrId=&sources=&actions=&isPrimaryStandalone=true&ComponentNumber=2`
and `POST Clinical/CareTeam/LoadExternal?hfrId=&sources=&actions=&ComponentNumber=2`
→ `{ProvidersList[], DescriptiveTitle, TabColorClass, IsCustomApptReqEnabled,
CustomRequestAppointmentLink}`.

The page issues BOTH and shows the union, so a client must too; de-duplicate on `ID`.
Provider fields: `Name`, `Specialty`, `Relation`, `IsExternal`, `CareTeamStatus`,
`NationalProviderID`, `Organizations`, `Photo`, `WebPageUrl`, `CanMessage`,
`CanDirectSchedule`, `CanRequestAppointment`, `SchedulableVisitTypes`, `AboutMeBlurb`.

> An earlier revision of this file claimed Care Team had no data endpoint. That was
> wrong — an artifact of reading a network log that truncated at 200 entries with
> CareTeam loaded last. When ruling an endpoint out, clear the log and load that page
> alone.

## Billing — server-rendered, no data endpoint

`Billing/Summary` issues no XHR at all (only its own page and two template/controller
bundles), so the accounts are rendered into the HTML and must be parsed. Confirmed by
clearing the network log and loading the page alone.

Account cards live in three containers, which is the bucket:

| Container id | Meaning |
|---|---|
| `ba_accountList` | outstanding |
| `ba_zeroAccountList` | zero balance |
| `ba_authAccountList` | guarantor-authorized |

Each `.ba_card` carries `.ba_card_header_saLabel_saName` (account name),
`.ba_card_header_account_idAndType`, `.ba_card_header_account_billsys`,
`.ba_card_header_account_patients`, `.ba_card_status_due_label` and
`.ba_card_status_due_amount`. `billingSystem` is empty on some accounts, so treat every
field as optional. See `src/parse.ts`.

## Documents — not captured

`Documents` renders no document list on the landing page (964 characters of visible text)
and issues no XHR. It most likely requires selecting a category first; that flow has not
been captured.


## Patient switching (proxy access)

The portal lets one login open several charts — the account holder's, plus anyone who
has granted them proxy access. Captured from a live signed-in session.

**Discovery has no endpoint.** The switcher's own list is embedded in any signed-in page
as repeated calls to
`EpicPx.ReactContext.personalizations.proxySubjects.push({ proxyColor, displayName,
photoMagicId, ids: [{type, value}, …] })`. `displayName` is a FIRST NAME only. The
account holder is the one subject carrying a `MYCHARTLOGIN` id.

**Switching** is `GET ProxySwitch/SwitchContext?eaccountid=<id>&redirecturl=<path>`,
found in the `react-core` bundle, which builds it as
`{ eaccountid, redirecturl }` whenever a link carries an `eaccountid`.

> **Only `WPRINTERNAL` is accepted, measured rather than assumed.** Each subject
> publishes seventeen id types — `C`, `CEID`, `CHS`, `E`, `EPI`, `EXTERNAL`, `FHIR`,
> `IDX`, `IDXUNPAD`, `INTERNAL`, `K`, `M`, `MYCHARTLOGIN`, `R`, `S`, `STAR`,
> `WPRINTERNAL`. All seventeen were tried against a real proxy subject. Sixteen return
> **HTTP 302 and silently leave the context unchanged**; only `WPRINTERNAL` switches.
> Nothing in the response distinguishes the two outcomes, so an id chosen by plausibility
> yields a switch that reports success and then serves the wrong patient's chart.

**Confirming a switch.** `POST api/health-summary/FetchHealthSummary` returns
`patientFirstName` and `header.patientAge` for whoever is currently being served — the
only cheap way to ask the portal who it thinks you are. Both fields are needed: the
first name alone cannot separate two subjects sharing one.

**The context lives in the session cookie.** A switch rotates
`_Host-MyChartNetAuthenticationTicket4myatriumhealth`, so it is carried by the stored
jar and survives a restart — and a fresh sign-in silently returns to the account holder.

**Ordinary reads rotate nothing.** A session polled every three minutes for 208 minutes
changed no cookie value; only a context switch did.

**Observed effect.** With the account holder selected, `conversations/GetConversationList`
returned 14 threads; with a proxy subject selected, 3 — none of which appeared in the
account holder's list. Switching back returned exactly the original 14.
