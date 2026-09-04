import { describe, expect, it } from 'vitest';
import { parseProxySubjects } from '../src/patients.js';

// Shape taken from the live signed-in Home page; ids are invented. The switcher
// publishes each subject as a push() call, and every id type EXCEPT WPRINTERNAL
// is silently ignored by ProxySwitch/SwitchContext — verified against all
// seventeen on a real account (docs/MYATRIUMHEALTH-API.md, "Patient switching").
const subject = (name: string, wpr: string, login: boolean): string => `
  EpicPx.ReactContext.personalizations.proxySubjects.push({proxyColor:1,displayName:"${name}",photoMagicId:"",ids:[
    {type:"C",value:"WP-24aaa"},
    {type:"CEID",value:"WP-24bbb"},
    {type:"EPI",value:"WP-24ccc"},
    ${login ? '{type:"MYCHARTLOGIN",value:"WP-24ddd"},' : ''}
    {type:"WPRINTERNAL",value:"${wpr}"}]});`;

const page = subject('Chris', 'WP-24holder', true) + subject('Finn', 'WP-24child', false);

describe('patient discovery', () => {
  it('is not fooled by a brace inside a quoted value', () => {
    // The hand-rolled depth counter this replaced counted braces without
    // knowing about strings, so a `}` inside a display name ended the object
    // early and the subject lost every id after it — including the only one
    // the switcher accepts. Names are user data; they are not guaranteed to
    // be free of punctuation.
    const awkward =
      'EpicPx.ReactContext.personalizations.proxySubjects.push({proxyColor:1,' +
      'displayName:"Bracey}",photoMagicId:"",ids:[' +
      '{type:"C",value:"WP-24aaa"},{type:"WPRINTERNAL",value:"WP-24kid"}]});';
    const [only] = parseProxySubjects(awkward);
    expect(only.displayName).toBe('Bracey}');
    expect(only.id).toBe('WP-24kid');
  });

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

describe('re-assertion after a silent re-login', () => {
  function clientServing(name: string, age: number | null) {
    const calls: string[] = [];
    const state = { name, age };
    return {
      calls,
      state,
      page: async (p: string) => {
        calls.push(p);
        if (p.startsWith('ProxySwitch/SwitchContext')) {
          state.name = 'Finn';
          state.age = 7;
        }
        return page;
      },
      api: async () => ({
        patientFirstName: state.name,
        header: { patientAge: state.age },
      }),
    };
  }

  it('re-switches after invalidate rather than trusting the cached name', async () => {
    // The defect this exists for: ServerTransport replays an expired session by
    // signing in again, which silently returns the portal to the account
    // holder. A cache that outlived that would label the account holder's
    // chart with the child's name — the worst failure this feature can have.
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-reauth-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext();
    const client = clientServing('Chris', 45);

    await ctx.select(client as never, {
      id: 'WP-24child',
      displayName: 'Finn',
      isAccountHolder: false,
      relationship: 'proxy',
    });
    expect(await ctx.ensure(client as never)).toBe('Finn');

    // The portal silently reverts, exactly as a re-login does.
    client.state.name = 'Chris';
    client.state.age = 45;
    ctx.invalidate();

    expect(await ctx.ensure(client as never)).toBe('Finn');
    expect(client.calls.filter((c) => c.startsWith('ProxySwitch/SwitchContext')).length)
      .toBeGreaterThan(1);
  });
});

describe('a sign-in that happens DURING a read', () => {
  it('never labels the account holder\'s data with the selected patient', async () => {
    // The reviewed defect: confirming the patient BEFORE the read is not
    // enough, because the transport replays an expired session by signing in
    // again — so the very read being labelled can be the one that resets the
    // portal to the account holder.
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-midread-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext();

    const state = { name: 'Chris', age: 45 as number | null };
    const client = {
      page: async (p: string) => {
        if (p.startsWith('ProxySwitch/SwitchContext')) {
          state.name = 'Finn';
          state.age = 7;
        }
        return page;
      },
      api: async () => ({ patientFirstName: state.name, header: { patientAge: state.age } }),
    };

    await ctx.select(client as never, {
      id: 'WP-24child', displayName: 'Finn', isAccountHolder: false, relationship: 'proxy',
    });

    let reads = 0;
    const result = await ctx.readAs(client as never, async () => {
      reads++;
      if (reads === 1) {
        // The read triggers a re-login: portal silently reverts, session changes.
        state.name = 'Chris';
        state.age = 45;
        ctx.invalidate();
        return 'account-holder-data';
      }
      return 'proxy-data';
    });

    // It must NOT return the first read labelled "Finn".
    expect(result).toEqual({ patient: 'Finn', data: 'proxy-data' });
    expect(reads).toBe(2);
  });

  it('refuses rather than guessing when the context keeps resetting', async () => {
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-thrash-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext();
    const state = { name: 'Chris', age: 45 as number | null };
    const client = {
      page: async (p: string) => {
        if (p.startsWith('ProxySwitch/SwitchContext')) { state.name = 'Finn'; state.age = 7; }
        return page;
      },
      api: async () => ({ patientFirstName: state.name, header: { patientAge: state.age } }),
    };
    await ctx.select(client as never, {
      id: 'WP-24child', displayName: 'Finn', isAccountHolder: false, relationship: 'proxy',
    });

    await expect(
      ctx.readAs(client as never, async () => {
        ctx.invalidate();
        return 'whatever';
      }),
    ).rejects.toThrow(/could not be established/);
  });
});

describe('caching is only allowed where invalidation is possible', () => {
  function probe(name: string) {
    const state = { name, age: 45 as number | null };
    let confirmations = 0;
    return {
      state,
      get confirmations() { return confirmations; },
      page: async (p: string) => {
        if (p.startsWith('ProxySwitch/SwitchContext')) { state.name = 'Finn'; state.age = 7; }
        return page;
      },
      api: async () => {
        confirmations++;
        return { patientFirstName: state.name, header: { patientAge: state.age } };
      },
    };
  }

  it('re-confirms every read through the browser bridge', async () => {
    // The defect: through the bridge the session lives in the user's own tab
    // and nothing announces a change — they can switch patients there
    // themselves. A cache would be a process-lifetime claim about whose
    // records these are.
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-bridge-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext(false);
    const client = probe('Chris');

    await ctx.ensure(client as never);
    const afterFirst = client.confirmations;
    await ctx.ensure(client as never);
    await ctx.ensure(client as never);

    expect(client.confirmations).toBeGreaterThan(afterFirst);
  });

  it('confirms once per session when sign-ins are announced', async () => {
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-cached-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext(true);
    const client = probe('Chris');

    await ctx.ensure(client as never);
    const afterFirst = client.confirmations;
    await ctx.ensure(client as never);
    await ctx.ensure(client as never);

    expect(client.confirmations).toBe(afterFirst);
  });

  it('labels a nameless summary consistently on every read', async () => {
    // Cached and uncached branches must agree: the fallback was on one only,
    // so the first read said "account holder" and the rest said "".
    process.env.MAH_PATIENT_FILE = `/tmp/mah-patient-noname-${Date.now()}.json`;
    const { PatientContext } = await import('../src/patient-context.js');
    const ctx = new PatientContext(true);
    const client = { page: async () => page, api: async () => ({ header: {} }) };

    const first = await ctx.ensure(client as never);
    const second = await ctx.ensure(client as never);
    expect(first).toBe('account holder');
    expect(second).toBe(first);
  });
});
