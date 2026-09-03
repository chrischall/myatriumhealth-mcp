import { describe, expect, it } from 'vitest';
import { parseBillingAccounts } from '../src/parse.js';

// Class names are taken from the live Billing/Summary page; values are invented.
// The parser is additionally verified against real fetched bytes (see
// docs/MYATRIUMHEALTH-API.md) — a fixture alone cannot prove the selectors match.
const card = (name: string, amount: string): string => `
  <div class="col-6 card ba_card">
    <div class="row fixed ba_card_header">
      <p class="ba_card_header_saLabel ba_card_header_saLabel_saName">${name}</p>
      <p class="ba_card_header_account_idAndType">Acct #123 · Hospital</p>
      <p class="ba_card_header_account_billsys">HB</p>
      <p class="ba_card_header_account_patients">A Patient</p>
    </div>
    <div class="ba_card_status row">
      <span class="ba_card_status_due_label">Amount due</span>
      <span class="money ba_card_status_due_amount moneyColor">${amount}</span>
    </div>
  </div>`;

const page = (): string => `<html><body>
  <div id="ba_accountList">${card('Outstanding One', '$42.00')}</div>
  <div id="ba_zeroAccountList">${card('Paid Off', '$0.00')}</div>
  <div id="ba_authAccountList">${card('Guarantor', '$7.00')}</div>
</body></html>`;

describe('parseBillingAccounts', () => {
  it('reads accounts from all three containers, tagged by bucket', () => {
    const a = parseBillingAccounts(page());
    expect(a).toHaveLength(3);
    expect(a.map((x) => x.bucket)).toEqual(['outstanding', 'zeroBalance', 'authorized']);
    expect(a[0]?.accountName).toBe('Outstanding One');
    expect(a[0]?.amountDue).toBe('$42.00');
    expect(a[1]?.accountName).toBe('Paid Off');
  });

  it('collapses whitespace in extracted text', () => {
    const html = `<div id="ba_accountList"><div class="ba_card">
      <p class="ba_card_header_saLabel_saName">  Spaced\n   Name  </p></div></div>`;
    expect(parseBillingAccounts(html)[0]?.accountName).toBe('Spaced Name');
  });

  it('omits fields that are absent or empty rather than emitting empty strings', () => {
    const html = `<div id="ba_accountList"><div class="ba_card">
      <p class="ba_card_header_saLabel_saName">Only Name</p>
      <p class="ba_card_header_account_billsys"></p></div></div>`;
    const a = parseBillingAccounts(html)[0]!;
    expect(a.accountName).toBe('Only Name');
    expect(a.billingSystem).toBeUndefined();
    expect(a.amountDue).toBeUndefined();
  });

  it('returns [] for a page with no account cards', () => {
    expect(parseBillingAccounts('<html><body><p>nothing</p></body></html>')).toEqual([]);
  });
});
