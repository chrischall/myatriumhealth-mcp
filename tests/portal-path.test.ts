import { describe, expect, it } from 'vitest';
import { imageLoadPath, imageFileNameFromSrc, portalPath } from '../src/portal-path.js';

// Message HTML and portal JSON are written by other people. Anything they
// point at is fetched with the patient's session, so only the portal's own
// app paths may be followed.
describe('portalPath', () => {
  it('accepts a root-relative path under the app root', () => {
    expect(portalPath('/myatriumhealth/Image/Load?fileName=abc')).toBe('Image/Load?fileName=abc');
  });

  it('accepts an absolute URL on the portal origin', () => {
    expect(portalPath('https://my.atriumhealth.org/myatriumhealth/Document/Get?x=1')).toBe(
      'Document/Get?x=1',
    );
  });

  it.each([
    ['another host', 'https://evil.example/myatriumhealth/Image/Load?fileName=a'],
    ['a look-alike host', 'https://my.atriumhealth.org.evil.example/myatriumhealth/x'],
    ['userinfo pointing elsewhere', 'https://my.atriumhealth.org@evil.example/myatriumhealth/x'],
    ['plain http', 'http://my.atriumhealth.org/myatriumhealth/x'],
    ['protocol-relative', '//evil.example/myatriumhealth/x'],
    ['a path outside the app root', '/otherapp/Image/Load?fileName=a'],
    ['traversal out of the app root', '/myatriumhealth/../admin/x'],
    ['a data URI', 'data:image/png;base64,AAAA'],
    ['javascript', 'javascript:alert(1)'],
    ['a backslash trick', '/\\evil.example/myatriumhealth/x'],
    ['an empty string', ''],
  ])('rejects %s', (_label, raw) => {
    expect(() => portalPath(raw)).toThrow(/portal/i);
  });

  it('accepts an app-relative path only when asked to', () => {
    expect(() => portalPath('Document/Get?x=1')).toThrow();
    expect(portalPath('Document/Get?x=1', { allowAppRelative: true })).toBe('Document/Get?x=1');
  });
});

describe('inline image paths', () => {
  it('builds the Image/Load path from a file name', () => {
    expect(imageLoadPath('6f1c2a3b-0000-4000-8000-000000000001')).toBe(
      'Image/Load?fileName=6f1c2a3b-0000-4000-8000-000000000001',
    );
  });

  it('refuses a file name that is not a plain token', () => {
    expect(() => imageLoadPath('../secret')).toThrow();
    expect(() => imageLoadPath('a&b=c')).toThrow();
  });

  it('reads the file name back out of an img src', () => {
    expect(imageFileNameFromSrc('/myatriumhealth/Image/Load?fileName=abc-123')).toBe('abc-123');
    expect(imageFileNameFromSrc('https://evil.example/Image/Load?fileName=abc')).toBeUndefined();
    expect(imageFileNameFromSrc('/myatriumhealth/Other/Load?fileName=abc')).toBeUndefined();
  });
});
