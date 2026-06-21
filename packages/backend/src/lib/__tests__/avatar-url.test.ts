import { describe, expect, it } from 'vitest';
import { buildStaticAvatarUrl } from '../avatar-url';

describe('buildStaticAvatarUrl', () => {
  it('adds a cache-busting version query param to a static avatar path', () => {
    expect(buildStaticAvatarUrl('user-1.jpg', 'upload-123')).toBe('/static/avatars/user-1.jpg?v=upload-123');
  });

  it('encodes the version value for use in a URL', () => {
    expect(buildStaticAvatarUrl('user-1.jpg', '2026-06-18 10:00')).toBe(
      '/static/avatars/user-1.jpg?v=2026-06-18%2010%3A00',
    );
  });
});
