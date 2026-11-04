import { UNTRUSTED_CONTENT_RULE, untrustedEnvelope } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { MAH_VIEWS, viewArg } from './view.js';

/**
 * The `brief` rung, offered only on the canonical reads a context group asks
 * (mah_list_messages, mah_list_upcoming_visits, mah_list_billing_accounts):
 * one text line per item, `title — <ISO date | no date> — <status>`, at most
 * 120 characters cut as a whole (title first), after a `-- patient: <label>`
 * note line naming whose chart was read, inside the untrusted-data envelope.
 *
 * It sits beside the fleet's compact/full rungs rather than inside
 * `viewParam`, whose vocabulary is the projection ladder; `brief` is a
 * different thing — a spoken-summary line — so these tools publish their own
 * enum and answer `brief` before falling through to `viewResponse`.
 */
export const BRIEF_VIEWS = [...MAH_VIEWS, 'brief'] as const;

const BRIEF_MAX = 120;

export function briefViewArg(itemLine: string) {
  return z
    .enum(BRIEF_VIEWS)
    .optional()
    .describe(`${viewArg().description ?? ''} "brief" answers one text line per item: ${itemLine}, after a "-- patient: <name>" note line naming whose chart was read.`.trim());
}

export function isBrief(view: string | undefined): boolean {
  return view === 'brief';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : undefined;
}

/**
 * An ISO date from what the portal gave: an ISO value passes through as is; a
 * US `M/D/YYYY` (as the server-rendered pages print dates) becomes
 * `YYYY-MM-DD`; anything else is `no date` rather than a guess.
 */
export function isoDate(v: unknown): string {
  const s = str(v);
  if (s === undefined) return 'no date';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split(' ')[0]!;
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return 'no date';
}

/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * `title — date — status`, cut to 120 characters as a WHOLE, title first: the
 * title shortens until the line fits, and only once it is at its floor does
 * the status give way too. A title that starts with `-- ` (which would read as
 * a note) or `\` (which the gateway would strip) is escaped with one leading
 * `\` — the fleet's brief-view contract.
 */
export function briefLine(title: string | undefined, date: string, status: string): string {
  const raw = title ?? '(untitled)';
  const shown = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const sep = ` — ${date} — `;
  const room = BRIEF_MAX - sep.length;
  if (shown.length + status.length <= room) return `${shown}${sep}${status}`;
  const titleRoom = Math.max(room - status.length, Math.min(shown.length, TITLE_FLOOR));
  const t = cut(shown, titleRoom);
  return cut(`${t}${sep}${cut(status, Math.max(room - t.length, 1))}`, BRIEF_MAX);
}

/**
 * The answer a brief read returns: the fleet's untrusted-data envelope,
 * minified, whose `data` is a leading `-- patient: <label>` note, then the
 * lines — or a `-- none` note when there are none. Every line's title is text
 * the health system or its staff wrote, never this server, so `whoWrote` names
 * them and the envelope's rule follows. A line starting with `-- ` is a note,
 * not an item (the fleet's brief-view contract), so the gateway does not count
 * it. The patient note is always there because a proxy login (a child's chart)
 * reads as another patient, and the other rungs carry `patient` beside the
 * data — the brief rung must not drop it.
 */
export function briefResult(patient: string, lines: string[], whoWrote: string) {
  const label = str(patient) ?? 'account holder';
  const data = [`-- patient: ${label}`, ...(lines.length === 0 ? ['-- none'] : lines)];
  const payload = untrustedEnvelope(data, { note: `${whoWrote} ${UNTRUSTED_CONTENT_RULE}` });
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

type Rec = Record<string, unknown>;
const records = (v: unknown): Rec[] =>
  Array.isArray(v)
    ? v.filter((x): x is Rec => !!x && typeof x === 'object')
    : v && typeof v === 'object'
      ? Object.values(v as Rec).filter((x): x is Rec => !!x && typeof x === 'object')
      : [];

/**
 * Message Center conversations: subject, the LATEST message's delivery
 * instant (`messages[]` is oldest first, captured 2026-09-21), unread when any
 * message in it is. Every field read here is in the captured payload.
 */
export function briefConversations(raw: unknown): string[] {
  const convs = records((raw as Rec | null)?.['conversations']);
  return convs.map((c) => {
    const msgs = records(c['messages']);
    const last = msgs.at(-1) ?? {};
    return briefLine(
      str(c['subject']) ?? '(no subject)',
      isoDate(last['deliveryInstantISO']),
      msgs.some((m) => m['isUnread'] === true) ? 'unread' : 'read',
    );
  });
}

const VISIT_BUCKETS = [
  ['InProgressVisits', 'in progress'],
  ['NextNDaysVisits', 'upcoming'],
  ['LaterVisitsList', 'upcoming'],
] as const;

/**
 * Upcoming visits. The three bucket keys are captured
 * (docs/MYATRIUMHEALTH-API.md); the per-visit fields are NOT, so this reads
 * only `PrimaryDate` and `Csn` (the fields the same endpoint family's past
 * list carries) and `VisitTypeName`, and falls back to `Appointment` /
 * `no date` rather than inventing more. A visit in two buckets (same `Csn`)
 * is listed once, in the first.
 */
export function briefUpcomingVisits(raw: unknown): string[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [key, status] of VISIT_BUCKETS) {
    for (const v of records(r[key])) {
      const csn = str(v['Csn']);
      if (csn !== undefined) {
        if (seen.has(csn)) continue;
        seen.add(csn);
      }
      out.push(briefLine(str(v['VisitTypeName']) ?? 'Appointment', isoDate(v['PrimaryDate']), status));
    }
  }
  return out;
}

/**
 * Billing accounts with something owed: the outstanding and
 * guarantor-authorized cards. Zero-balance accounts are left out — nothing on
 * them is due. The page prints no due date ("Amount due"), so the date is read
 * from the label only when it carries one.
 */
export function briefBillingAccounts(
  accounts: { accountName?: string; dueLabel?: string; amountDue?: string; bucket: string }[],
): string[] {
  return accounts
    .filter((a) => a.bucket !== 'zeroBalance')
    .map((a) =>
      briefLine(a.accountName ?? 'Billing account', isoDate(a.dueLabel), a.amountDue ? `${a.amountDue} due` : 'balance due'),
    );
}
