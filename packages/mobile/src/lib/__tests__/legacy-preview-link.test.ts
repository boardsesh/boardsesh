import { describe, expect, it } from 'vitest';
import { isLegacyPreviewLink } from '../legacy-preview-link';

describe('isLegacyPreviewLink', () => {
  it.each([
    'https://www.boardsesh.com/preview/pr-1',
    'https://boardsesh.com/preview/pr-4792',
    'com.boardsesh.app://preview/pr-99',
    'com.boardsesh.app:///preview/pr-99',
    '/preview/pr-99',
  ])('recognizes a retired preview-link form: %s', (url) => {
    expect(isLegacyPreviewLink(url)).toBe(true);
  });

  it.each([
    'https://www.boardsesh.com/es/preview/pr-99',
    'https://www.boardsesh.com/fr/preview/pr-99',
    'https://www.boardsesh.com/de/preview/pr-99',
    'com.boardsesh.app:///es/preview/pr-99',
  ])('recognizes supported locale prefixes: %s', (url) => {
    expect(isLegacyPreviewLink(url)).toBe(true);
  });

  it.each([
    'https://www.boardsesh.com/preview/pr-99/',
    'https://www.boardsesh.com/preview/pr-99?utm_source=github',
    'https://www.boardsesh.com/preview/pr-99#install',
    'https://www.boardsesh.com/preview/pr-99/?utm_source=github#install',
  ])('ignores a harmless URL tail: %s', (url) => {
    expect(isLegacyPreviewLink(url)).toBe(true);
  });

  it.each([
    '',
    'https://www.boardsesh.com/preview',
    'https://www.boardsesh.com/previews/pr-99',
    'https://www.boardsesh.com/preview/production',
    'https://www.boardsesh.com/preview/pr-0',
    'https://www.boardsesh.com/preview/pr-007',
    'https://www.boardsesh.com/preview/pr-99x',
    'https://www.boardsesh.com/preview/PR-99',
    'https://www.boardsesh.com/go/preview/pr-99',
    'https://www.boardsesh.com/preview/pr-99/extra',
    'https://evil.example/preview/pr-99',
    'https://boardsesh.compreview/pr-99',
    'https://boardsesh.com.evil.example/preview/pr-99',
    'https://boardsesh.com@evil.example/preview/pr-99',
    'http://www.boardsesh.com/preview/pr-99',
  ])('rejects a near miss: %s', (url) => {
    expect(isLegacyPreviewLink(url)).toBe(false);
  });

  it('rejects a PR number that cannot be represented safely', () => {
    expect(isLegacyPreviewLink('https://www.boardsesh.com/preview/pr-9007199254740992')).toBe(false);
  });
});
