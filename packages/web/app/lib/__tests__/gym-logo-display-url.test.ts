import { describe, expect, it } from 'vitest';
import { resolveGymLogoDisplayUrl, resolveGymPhotoDisplayUrl } from '../gym-logo-display-url';

describe('resolveGymLogoDisplayUrl', () => {
  const storedPath = '/static/gym-logos/abc.png?v=123';

  it('resolves the stored backend-relative path against the backend origin', () => {
    expect(resolveGymLogoDisplayUrl(storedPath, 'http://localhost:8080')).toBe(`http://localhost:8080${storedPath}`);
    expect(resolveGymLogoDisplayUrl(storedPath, 'https://ws.boardsesh.com')).toBe(
      `https://ws.boardsesh.com${storedPath}`,
    );
  });

  it('tolerates a trailing slash on the backend base', () => {
    expect(resolveGymLogoDisplayUrl(storedPath, 'https://ws.boardsesh.com/')).toBe(
      `https://ws.boardsesh.com${storedPath}`,
    );
  });

  it('passes through null and absolute URLs untouched', () => {
    expect(resolveGymLogoDisplayUrl(null, 'http://localhost:8080')).toBeNull();
    expect(resolveGymLogoDisplayUrl('https://cdn.example.com/logo.png', 'http://localhost:8080')).toBe(
      'https://cdn.example.com/logo.png',
    );
  });

  it('keeps the relative path when no backend base is known', () => {
    expect(resolveGymLogoDisplayUrl(storedPath, null)).toBe(storedPath);
  });

  it('treats protocol-relative URLs as already absolute', () => {
    expect(resolveGymLogoDisplayUrl('//cdn.example.com/logo.png', 'https://ws.boardsesh.com')).toBe(
      '//cdn.example.com/logo.png',
    );
  });
});

describe('resolveGymPhotoDisplayUrl', () => {
  const storedPath = '/static/gym-photos/abc.jpg?v=123';

  it('resolves the stored backend-relative path against the backend origin', () => {
    expect(resolveGymPhotoDisplayUrl(storedPath, 'https://ws.boardsesh.com')).toBe(
      `https://ws.boardsesh.com${storedPath}`,
    );
  });

  it('passes through null and absolute URLs untouched', () => {
    expect(resolveGymPhotoDisplayUrl(null, 'https://ws.boardsesh.com')).toBeNull();
    expect(resolveGymPhotoDisplayUrl('https://cdn.example.com/gym.jpg', 'https://ws.boardsesh.com')).toBe(
      'https://cdn.example.com/gym.jpg',
    );
  });
});
