import { describe, expect, it } from 'vitest';
import { parseProxySubjects } from '../src/patients.js';

// Shape taken from the live signed-in Home page; ids are invented. The switcher
// publishes each subject as a push() call, and every id type EXCEPT WPRINTERNAL
// is silently ignored by ProxySwitch/SwitchContext — verified against all
// seventeen on a real account (docs/MYATRIUMHEALTH-API.md).
const subject = (name: string, wpr: string, login: boolean): string => `
  EpicPx.ReactContext.personalizations.proxySubjects.push({proxyColor:1,displayName:"${name}",photoMagicId:"",ids:[
    {type:"C",value:"WP-24aaa"},
    {type:"CEID",value:"WP-24bbb"},
    {type:"EPI",value:"WP-24ccc"},
    ${login ? '{type:"MYCHARTLOGIN",value:"WP-24ddd"},' : ''}
    {type:"WPRINTERNAL",value:"${wpr}"}]});`;

const page = subject('Chris', 'WP-24holder', true) + subject('Finn', 'WP-24child', false);

describe('patient discovery', () => {
  it('finds every subject the switcher offers', () => {
    expect(parseProxySubjects(page).map((p) => p.displayName)).toEqual(['Chris', 'Finn']);
  });

  it('uses WPRINTERNAL as the id, because it is the only one the switcher honours', () => {
    // Guards the defect that cost the most to find: the other sixteen id types
    // return the same HTTP 302 and leave the context untouched, so picking one
    // of them yields a switch that reports success and serves the wrong chart.
    expect(parseProxySubjects(page).map((p) => p.id)).toEqual(['WP-24holder', 'WP-24child']);
  });

  it('marks the account holder by their MYCHARTLOGIN id', () => {
    const [holder, proxy] = parseProxySubjects(page);
    expect(holder.isAccountHolder).toBe(true);
    expect(holder.relationship).toBe('self');
    expect(proxy.isAccountHolder).toBe(false);
    expect(proxy.relationship).toBe('proxy');
  });

  it('ignores a subject with no usable switch id rather than inventing one', () => {
    const broken = '...proxySubjects.push({displayName:"Nobody",ids:[{type:"C",value:"WP-24x"}]});';
    expect(parseProxySubjects(broken)).toEqual([]);
  });

  it('reads nothing out of a page that has no switcher', () => {
    expect(parseProxySubjects('<html><body>signed in</body></html>')).toEqual([]);
  });
});

describe('the default patient', () => {
  const holderPage = page;

  function fakeClient(serving = 'Chris') {
    const calls: string[] = [];
    return {
      calls,
      page: async (p: string) => {
        calls.push(`GET ${p}`);
        return holderPage;
      },
      api: async (e: string) => {
        calls.push(`API ${e}`);
        return { patientFirstName: serving, header: { patientAge: 45 } };
      },
    };
  }

  it('reads as the account holder and never switches when nothing is selected', async () => {
    // The backward-compatibility guarantee, pinned: a connector that has never
    // been told about patients must behave exactly as it did before they
    // existed — which means it must not call the switcher at all.
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-default-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext();
    const client = fakeClient('Chris');

    expect(ctx.isDefault()).toBe(true);
    await expect(ctx.ensure(client as never)).resolves.toBe('Chris');
    expect(client.calls.some((c) => c.includes('SwitchContext'))).toBe(false);
  });
});
