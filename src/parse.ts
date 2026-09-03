// Billing Summary is one of the few areas with NO data endpoint — it issues no
// XHR at all, so the accounts are server-rendered into the page and must be
// parsed. Selectors below were read off the live page (see
// docs/MYATRIUMHEALTH-API.md) rather than guessed.

import { parse } from 'node-html-parser';

export interface BillingAccount {
  accountName?: string;
  accountIdAndType?: string;
  billingSystem?: string;
  patients?: string;
  dueLabel?: string;
  amountDue?: string;
  /** Which list the card came from: outstanding, zero-balance or guarantor-authorized. */
  bucket: string;
}

const BUCKETS: Record<string, string> = {
  ba_accountList: 'outstanding',
  ba_zeroAccountList: 'zeroBalance',
  ba_authAccountList: 'authorized',
};

const text = (el: { querySelector: (s: string) => { text?: string } | null }, sel: string):
  | string
  | undefined => {
  const t = el.querySelector(sel)?.text?.replace(/\s+/g, ' ').trim();
  return t !== undefined && t !== '' ? t : undefined;
};

/**
 * Parse the billing accounts out of a Billing/Summary page.
 *
 * Returns `[]` when no account cards are present — the caller should treat that
 * as "no accounts rendered" rather than an error, since a page fetched without
 * a session raises earlier in the client.
 */
export function parseBillingAccounts(html: string): BillingAccount[] {
  const root = parse(html);
  const out: BillingAccount[] = [];
  for (const [containerId, bucket] of Object.entries(BUCKETS)) {
    const container = root.querySelector(`#${containerId}`);
    if (!container) continue;
    for (const card of container.querySelectorAll('.ba_card')) {
      const account: BillingAccount = { bucket };
      const name = text(card, '.ba_card_header_saLabel_saName');
      const idAndType = text(card, '.ba_card_header_account_idAndType');
      const billsys = text(card, '.ba_card_header_account_billsys');
      const patients = text(card, '.ba_card_header_account_patients');
      const dueLabel = text(card, '.ba_card_status_due_label');
      const amountDue = text(card, '.ba_card_status_due_amount');
      if (name !== undefined) account.accountName = name;
      if (idAndType !== undefined) account.accountIdAndType = idAndType;
      if (billsys !== undefined) account.billingSystem = billsys;
      if (patients !== undefined) account.patients = patients;
      if (dueLabel !== undefined) account.dueLabel = dueLabel;
      if (amountDue !== undefined) account.amountDue = amountDue;
      out.push(account);
    }
  }
  return out;
}
