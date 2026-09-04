import { describe, expect, it } from 'vitest';
import { stripMediaUrls } from '@chrischall/mcp-utils';

/**
 * What `view: 'compact'` actually removes from a MyAtriumHealth response.
 *
 * MyAtriumHealth is camelCase throughout, and its photo endpoints are handler
 * URLs with no file extension — so the VALUE rule cannot judge them and the KEY
 * rule is the only thing that can. That combination is exactly where
 * mcp-utils 0.23.0 fell short: it required a `_`/`-` separator before the media
 * noun, so `cover_photo` was stripped and `coverPhoto` was kept — the same
 * field, a different answer decided by an API's casing convention.
 *
 * Pinned here rather than trusted upstream, because a regression there would
 * show up as MyAtriumHealth responses quietly growing image URLs again.
 */
describe('compact strips camelCase media keys on extension-less URLs', () => {
  const url = 'https://my.atriumhealth.org/myatriumhealth/photo/render/1234';

  it.each([
    'photoUrl',
    'coverPhoto',
    'profileImage',
    'primaryPhotoUrl',
    'tallAvatar',
    'imageSrc',
    'thumbnailUri',
  ])('drops %s', (key) => {
    const out = stripMediaUrls({ [key]: url, name: 'A Patient' }) as Record<string, unknown>;
    expect(out).not.toHaveProperty(key);
    expect(out).toHaveProperty('name');
  });

  it('keeps an id that merely mentions a photo', () => {
    // proxySubjects carries photoMagicId, which is an identifier and not a URL.
    const out = stripMediaUrls({ photoMagicId: 'abc123' }) as Record<string, unknown>;
    expect(out).toHaveProperty('photoMagicId');
  });

  it('keeps a genuine page URL', () => {
    const out = stripMediaUrls({ detailUrl: 'https://x/visit/9' }) as Record<string, unknown>;
    expect(out).toHaveProperty('detailUrl');
  });
});
