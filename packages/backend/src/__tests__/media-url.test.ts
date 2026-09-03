import { describe, expect, it } from 'vite-plus/test';
import { buildMediaObjectUrl, mediaVariantKey, staticPathToMediaRedirect } from '../lib/media-url';
import { resizedVariantKey } from '../lib/image-resize';

const BASE = 'https://media.boardsesh.com';

function redirect(path: string, query = ''): string | null {
  return staticPathToMediaRedirect(path, new URLSearchParams(query), BASE);
}

describe('mediaVariantKey', () => {
  it('matches the key the resize path actually writes', () => {
    // These two must agree or every sized request 404s: one builds the URL,
    // the other names the object.
    expect(mediaVariantKey('avatars/u1.jpg', 280)).toBe(resizedVariantKey('avatars/u1.jpg', 280));
  });

  it('returns the base key when no size is requested', () => {
    expect(mediaVariantKey('avatars/u1.jpg', null)).toBe('avatars/u1.jpg');
  });
});

describe('buildMediaObjectUrl', () => {
  it('joins base and key with a single slash', () => {
    expect(buildMediaObjectUrl('https://media.boardsesh.com/', 'avatars/u1.jpg')).toBe(
      'https://media.boardsesh.com/avatars/u1.jpg',
    );
  });

  it('appends the version as a query param, not into the key', () => {
    // The object store ignores unknown query params, so ?v= gives per-version
    // URL immutability without a versioned key layout to garbage-collect.
    expect(buildMediaObjectUrl(BASE, 'avatars/u1.jpg', null, 'abc-123')).toBe(
      'https://media.boardsesh.com/avatars/u1.jpg?v=abc-123',
    );
  });

  it('encodes a version containing URL-significant characters', () => {
    expect(buildMediaObjectUrl(BASE, 'avatars/u1.jpg', null, 'a&b c')).toBe(
      'https://media.boardsesh.com/avatars/u1.jpg?v=a%26b%20c',
    );
  });
});

describe('staticPathToMediaRedirect', () => {
  it('maps an avatar with size and version', () => {
    expect(redirect('/static/avatars/u1.jpg', 'v=abc&size=64')).toBe(
      'https://media.boardsesh.com/avatars/u1.jpg@64.jpg?v=abc',
    );
  });

  it('maps an avatar without a size to the base object', () => {
    expect(redirect('/static/avatars/u1.jpg', 'v=abc')).toBe('https://media.boardsesh.com/avatars/u1.jpg?v=abc');
  });

  it.each([
    ['/static/gym-logos/g1.png', 'gym-logos/g1.png'],
    ['/static/gym-photos/g1.jpg', 'gym-photos/g1.jpg'],
  ])('maps %s', (path, key) => {
    expect(redirect(path)).toBe(`${BASE}/${key}`);
  });

  it('maps a beta thumbnail, including the platform segment', () => {
    expect(redirect('/static/beta-link-thumbnails/instagram/ABC.jpg', 'size=280')).toBe(
      'https://media.boardsesh.com/beta-link-thumbnails/instagram/ABC.jpg@280.jpg',
    );
    expect(redirect('/static/beta-link-thumbnails/tiktok/cache_42.jpg')).toBe(
      'https://media.boardsesh.com/beta-link-thumbnails/tiktok/cache_42.jpg',
    );
  });

  it('drops an off-allowlist size rather than honouring it', () => {
    // Matches parseSizeParam: a size we never generated resolves to the base
    // object instead of a guaranteed 404.
    expect(redirect('/static/avatars/u1.jpg', 'size=999')).toBe('https://media.boardsesh.com/avatars/u1.jpg');
    expect(redirect('/static/avatars/u1.jpg', 'size=abc')).toBe('https://media.boardsesh.com/avatars/u1.jpg');
  });

  describe('refuses to map anything it does not recognise', () => {
    it.each([
      ['a non-static path', '/api/whatever'],
      ['an unknown static route', '/static/secrets/key.txt'],
      ['a missing filename', '/static/avatars/'],
      ['a nested path under a simple route', '/static/avatars/nested/u1.jpg'],
      ['a nested path under a thumbnail platform', '/static/beta-link-thumbnails/instagram/a/b.jpg'],
      ['an unknown thumbnail platform', '/static/beta-link-thumbnails/youtube/ABC.jpg'],
      ['a thumbnail filename that is not .jpg', '/static/beta-link-thumbnails/instagram/ABC.png'],
      ['a bare thumbnail path', '/static/beta-link-thumbnails/instagram'],
    ])('%s', (_label, path) => {
      expect(redirect(path)).toBeNull();
    });

    it.each([
      ['parent traversal', '/static/avatars/..'],
      ['current directory', '/static/avatars/.'],
      ['an encoded separator', '/static/avatars/a%2Fb.jpg'],
      ['a filename with a space', '/static/avatars/a b.jpg'],
    ])('%s', (_label, path) => {
      // A path this rejects falls through to the existing proxy, which applies
      // the same guard — so a rejection here is never a hole, only a slower path.
      expect(redirect(path)).toBeNull();
    });
  });

  it('never lets a crafted path escape the media prefix', () => {
    // The redirect target is a Location header: a value that resolved outside
    // the media host would be an open redirect.
    const crafted = [
      '/static/avatars/u1.jpg',
      '/static/gym-logos/g1.png',
      '/static/beta-link-thumbnails/instagram/ABC.jpg',
    ];
    for (const path of crafted) {
      const target = redirect(path);
      expect(target).not.toBeNull();
      expect(new URL(target!).origin).toBe('https://media.boardsesh.com');
    }
  });
});
