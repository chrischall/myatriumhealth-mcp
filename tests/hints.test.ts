import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { MyAtriumHealthAuth } from '../src/auth.js';
import { MyAtriumHealthClient } from '../src/client.js';
import { PatientContext } from '../src/patient-context.js';
import type { FetchResult, MahTransport } from '../src/transport.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerMahHealthcheckTool } from '../src/tools/healthcheck.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerPatientTools } from '../src/tools/patients.js';
import { registerRecordTools } from '../src/tools/records.js';
import { registerResultTools } from '../src/tools/results.js';
import { registerVisitTools } from '../src/tools/visits.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host sees. Every fixture below is synthetic.
 */

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const signedInPage =
  `<html><head><title>MyAtriumHealth - Home</title></head><body>` +
  `<script id='cspScripts' nonce='0123456789abcdef0123456789abcdef'></script>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" /></body></html>`;

const conversations = {
  conversations: [
    {
      hthId: 'WP-thread-1',
      subject: 'Your refill request',
      messages: [
        { wmgId: 'm1', deliveryInstantISO: '2026-10-01T12:00:00Z', isUnread: false },
        { wmgId: 'm2', deliveryInstantISO: '2026-11-02T09:30:00Z', isUnread: true },
      ],
    },
    {
      hthId: 'WP-thread-2',
      subject: `A very long subject line ${'x'.repeat(200)}`,
      messages: [{ wmgId: 'm3', deliveryInstantISO: '2026-10-20T08:00:00Z', isUnread: false }],
    },
    { hthId: 'WP-thread-3', messages: [] },
  ],
  users: {},
};

const upcoming = {
  InProgressVisits: [{ Csn: '1', VisitTypeName: 'Lab Visit', PrimaryDate: '2026-11-04T08:00:00' }],
  NextNDaysVisits: [{ Csn: '2', VisitTypeName: 'Office Visit', PrimaryDate: '11/06/2026' }],
  LaterVisitsList: [
    { Csn: '2', VisitTypeName: 'Office Visit', PrimaryDate: '11/06/2026' },
    { Csn: '3' },
  ],
  HighlightDays: [],
};

const card = (name: string, amount: string) => `
  <div class="ba_card">
    <span class="ba_card_header_saLabel_saName">${name}</span>
    <span class="ba_card_status_due_label">Amount due</span>
    <span class="money ba_card_status_due_amount moneyColor">${amount}</span>
  </div>`;
const billingPage =
  `<html><head><title>MyAtriumHealth - Billing</title></head><body>` +
  `<input name="__RequestVerificationToken" type="hidden" value="${'a'.repeat(172)}" />` +
  `<div id="ba_accountList">${card('Guarantor Account', '$42.00')}</div>` +
  `<div id="ba_zeroAccountList">${card('Old Account', '$0.00')}</div>` +
  `</body></html>`;

const json = (v: unknown): FetchResult => ({ status: 200, body: JSON.stringify(v) });

const transport: MahTransport = {
  start: async () => {},
  close: async () => {},
  fetch: async (init) => {
    if (init.path.includes('FetchHealthSummary')) return json({ patientFirstName: 'Pat', header: { patientAge: 40 } });
    if (init.path.includes('GetOrganizations')) return json({ organizations: {} });
    if (init.path.includes('GetConversationList')) return json(conversations);
    if (init.path.includes('LoadUpcoming')) return json(upcoming);
    if (init.path.includes('Billing/Summary')) return { status: 200, body: billingPage };
    return { status: 200, body: signedInPage };
  },
};

async function harness() {
  process.env.MAH_PATIENT_FILE = `/tmp/mah-hints-${Date.now()}-${Math.random()}.json`;
  const client = new MyAtriumHealthClient({ transport });
  const patients = new PatientContext();
  const auth = new MyAtriumHealthAuth({
    credentials: () => ({ username: 'u', password: 'p' }),
    persistence: { load: () => null, save: () => {} },
  });
  return createTestHarness((server) => {
    registerRecordTools(server, client, patients);
    registerResultTools(server, client, patients);
    registerVisitTools(server, client, patients);
    registerAccountTools(server, client, patients);
    registerBillingTools(server, client, patients);
    registerMessageTools(server, client, patients, { readOnly: false, attachmentsSupported: true });
    registerPatientTools(server, client, patients);
    registerAuthTools(server, auth);
    registerMahHealthcheckTool(server, client, { auth, bridge: undefined });
  });
}

async function served(): Promise<Listed[]> {
  const h = await harness();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

async function brief(name: string, args: Record<string, unknown> = {}): Promise<string[]> {
  const h = await harness();
  const res = await h.callTool(name, { ...args, view: 'brief' });
  await h.close();
  expect(res.isError, name).not.toBe(true);
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return text === '' ? [] : text.split('\n');
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  mah_auth_status: 'lookup',
  mah_sign_in: 'other',
  mah_send_verification_code: 'other',
  mah_verify_code: 'other',
  mah_get_health_summary: 'lookup',
  mah_get_patient_context: 'lookup',
  mah_list_allergies: 'lookup',
  mah_list_billing_accounts: 'whats-due',
  mah_list_care_team: 'lookup',
  mah_list_goals: 'lookup',
  mah_list_health_issues: 'lookup',
  mah_list_immunizations: 'lookup',
  mah_list_insurance: 'lookup',
  mah_list_medications: 'lookup',
  mah_list_message_folders: 'lookup',
  mah_list_messages: 'whats-new',
  mah_list_past_visits: 'lookup',
  mah_list_patients: 'lookup',
  mah_list_test_results: 'whats-new',
  mah_list_upcoming_visits: 'whats-on',
  mah_reply_message: 'send',
  mah_set_active_patient: 'change',
};

const CANONICAL = ['mah_list_billing_accounts', 'mah_list_messages', 'mah_list_upcoming_visits'];

describe('_meta.mint on tools/list', () => {
  it('hints every served tool except the mcp-utils healthcheck, so a new tool cannot skip the decision', async () => {
    const tools = await served();
    expect(tools.filter((t) => !t._meta?.mint).map((t) => t.name)).toEqual(['mah_healthcheck']);
    expect(tools.filter((t) => t._meta?.mint).map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s is in the health group with intent %s', async (name, intent) => {
    const mint = (await served()).find((t) => t.name === name)?._meta?.mint;
    expect(mint?.domain).toBe('health');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const mint = t._meta?.mint;
      if (!mint) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) expect(mint.canonical, t.name).toBe(true);
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start!);
        expect(props, t.name).toHaveProperty(when.end!);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^mah_/);
        }
      }
    }
  });

  it('marks canonical only read-only what’s-new/due/on reads, at most one per intent', async () => {
    const tools = await served();
    const canonical = tools.filter((t) => t._meta?.mint?.canonical === true);
    expect(canonical.map((t) => t.name).sort()).toEqual(CANONICAL);
    for (const t of canonical) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta?.mint?.intent);
    }
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta?.mint?.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('declares no subject: the reads serve the session’s active patient, which is not a per-call argument', async () => {
    for (const t of await served()) expect(t._meta?.mint ?? {}, t.name).not.toHaveProperty('subject');
  });

  it('every canonical read accepts view: brief', async () => {
    for (const t of (await served()).filter((x) => x._meta?.mint?.canonical === true)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
  });
});

const BRIEF_LINE = /^.+ — (\d{4}-\d{2}-\d{2}\S*|no date) — .+$/;

function expectBrief(lines: string[]) {
  for (const l of lines) {
    expect(l.length, l).toBeLessThanOrEqual(120);
    expect(l).toMatch(BRIEF_LINE);
  }
}

describe('brief view on the canonical reads', () => {
  it('mah_list_messages answers one line per conversation, dated by its latest message', async () => {
    const lines = await brief('mah_list_messages');
    expect(lines.shift()).toBe('-- patient: Pat');
    expect(lines).toHaveLength(3);
    expectBrief(lines);
    expect(lines[0]).toBe('Your refill request — 2026-11-02T09:30:00Z — unread');
    expect(lines[1]).toMatch(/^A very long subject line x+… — 2026-10-20T08:00:00Z — read$/);
    expect(lines[2]).toBe('(no subject) — no date — read');
  });

  it('mah_list_upcoming_visits answers one line per visit, each once', async () => {
    const lines = await brief('mah_list_upcoming_visits');
    expect(lines.shift()).toBe('-- patient: Pat');
    expect(lines).toEqual([
      'Lab Visit — 2026-11-04T08:00:00 — in progress',
      'Office Visit — 2026-11-06 — upcoming',
      'Appointment — no date — upcoming',
    ]);
    expectBrief(lines);
  });

  it('mah_list_billing_accounts answers one line per account with a balance', async () => {
    const lines = await brief('mah_list_billing_accounts');
    expect(lines.shift()).toBe('-- patient: Pat');
    expect(lines).toEqual(['Guarantor Account — no date — $42.00 due']);
    expectBrief(lines);
  });

  it('keeps the existing views untouched', async () => {
    const h = await harness();
    const res = await h.callTool('mah_list_billing_accounts', {});
    await h.close();
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Guarantor Account');
    expect(text).toContain('zeroBalance');
  });
});

describe('brief helpers', () => {
  it('leads every brief answer with the patient the read ran as, as a note line', async () => {
    const { briefResult } = await import('../src/brief.js');
    const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
    // A proxy read (a child's chart) names that patient, so the lines are not
    // mistaken for the account holder's.
    expect(text(briefResult('Sam', ['Physical — no date — upcoming']))).toBe(
      '-- patient: Sam\nPhysical — no date — upcoming',
    );
    // Nothing listed still says whose chart was read.
    expect(text(briefResult('Sam', []))).toBe('-- patient: Sam');
    // A label can never break out of its one note line.
    expect(text(briefResult(' Sam\n  Lee ', []))).toBe('-- patient: Sam Lee');
    expect(text(briefResult('', []))).toBe('-- patient: account holder');
  });

  it('dates only what reads as a date', async () => {
    const { isoDate } = await import('../src/brief.js');
    expect(isoDate('Amount due')).toBe('no date');
    expect(isoDate(undefined)).toBe('no date');
    expect(isoDate('Due 1/5/2027')).toBe('2027-01-05');
    expect(isoDate('2026-11-04')).toBe('2026-11-04');
  });

  it('a balance with no amount still reads as due, and a missing payload lists nothing', async () => {
    const { briefBillingAccounts, briefConversations, briefUpcomingVisits } = await import('../src/brief.js');
    expect(briefBillingAccounts([{ bucket: 'authorized' }])).toEqual(['Billing account — no date — balance due']);
    expect(briefConversations(null)).toEqual([]);
    expect(briefUpcomingVisits(undefined)).toEqual([]);
    expect(briefUpcomingVisits({ LaterVisitsList: { a: { VisitTypeName: 'Physical' } } })).toEqual([
      'Physical — no date — upcoming',
    ]);
  });
});
