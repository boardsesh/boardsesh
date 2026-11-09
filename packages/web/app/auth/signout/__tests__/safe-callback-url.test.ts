import { describe, expect, it } from 'vite-plus/test';
import { SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { applyLocale } from '@/app/lib/i18n/locale-href';
import { safeCallbackUrl } from '../safe-callback-url';

const SITE_ORIGIN = 'https://www.boardsesh.com';

describe('safeCallbackUrl', () => {
  it('keeps a same-origin relative path', () => {
    expect(safeCallbackUrl('/app')).toBe('/app');
    expect(safeCallbackUrl('/app/play?x=1#frag')).toBe('/app/play?x=1#frag');
    expect(safeCallbackUrl('/')).toBe('/');
  });

  it('rejects a protocol-relative URL', () => {
    expect(safeCallbackUrl('//evil.com')).toBe('/');
    expect(safeCallbackUrl('//evil.com/app')).toBe('/');
  });

  it('rejects the backslash protocol-relative variant browsers normalise to //', () => {
    expect(safeCallbackUrl('/\\evil.com')).toBe('/');
    expect(safeCallbackUrl('/\\/evil.com')).toBe('/');
  });

  it('rejects an absolute URL', () => {
    expect(safeCallbackUrl('https://evil.com')).toBe('/');
    expect(safeCallbackUrl('http://evil.com/app')).toBe('/');
  });

  it('rejects a javascript: (and other non-path) scheme', () => {
    expect(safeCallbackUrl('javascript:alert(1)')).toBe('/');
    expect(safeCallbackUrl('data:text/html,x')).toBe('/');
    expect(safeCallbackUrl('mailto:a@b.com')).toBe('/');
  });

  it('rejects empty, null, undefined, and non-path values', () => {
    expect(safeCallbackUrl(null)).toBe('/');
    expect(safeCallbackUrl(undefined)).toBe('/');
    expect(safeCallbackUrl('')).toBe('/');
    expect(safeCallbackUrl('app/play')).toBe('/');
    expect(safeCallbackUrl(' /app')).toBe('/');
  });

  it.each([
    ['tab', '/\t/evil.example'],
    ['newline', '/\n/evil.example'],
    ['carriage return', '/\r/evil.example'],
    ['tab before a backslash', '/\t\\evil.example'],
    ['several tabs', '/\t\t/\tevil.example'],
    ['tab with a path and query after it', '/\t/evil.example/path?x=1'],
    ['null byte', '/\u0000/evil.example'],
    ['delete character', '/\u007f/evil.example'],
    ['control character later in the path', '/app\tplay'],
  ])('rejects a control character: %s', (_label, callbackUrl) => {
    expect(safeCallbackUrl(callbackUrl)).toBe('/');
    expect(safeCallbackUrl(callbackUrl, SITE_ORIGIN)).toBe('/');
  });

  it.each([
    ['encoded tab', '/%09/evil.example'],
    ['encoded newline', '/%0a/evil.example'],
    ['encoded newline, upper case', '/%0A/evil.example'],
    ['encoded carriage return', '/%0d/evil.example'],
    ['encoded slash', '/%2f/evil.example'],
    ['encoded slash, upper case', '/%2Fevil.example'],
    ['encoded backslash', '/%5cevil.example'],
    ['encoded backslash, upper case', '/%5C/evil.example'],
    ['twice-encoded tab', '/%2509/evil.example'],
    ['twice-encoded slash', '/%252Fevil.example'],
    ['three-times-encoded backslash', '/%25255Cevil.example'],
    ['a percent sign spelled in hex', '/%25%32%46evil.example'],
    ['encoded control character later in the path', '/app%0Aplay'],
  ])('rejects an encoded form: %s', (_label, callbackUrl) => {
    expect(safeCallbackUrl(callbackUrl)).toBe('/');
    expect(safeCallbackUrl(callbackUrl, SITE_ORIGIN)).toBe('/');
  });

  it('rejects encoding nested deeper than any return path we generate', () => {
    const nestedEncoding = `/%${'25'.repeat(9)}2Fevil.example`;
    expect(safeCallbackUrl(nestedEncoding)).toBe('/');
  });

  it.each([
    ['gym claim return', '/gym/boulderwelt?claim=1'],
    ['locale-prefixed return', '/fr/gyms/new?gym=0b5c2c0e-6d0a-4a55-9a0f-0d9f3f0a7c11'],
    ['board invite return', '/b/the-garage?invite=abc123'],
    ['gym manage return', '/gym/bloclab/manage'],
    ['encoded space in a slug', '/setter/jimmy%20webb'],
    ['UTF-8 slug', '/setter/caf%C3%A9'],
    ['encoded percent in a slug', '/setter/100%25'],
    ['a stray percent sign', '/setter/100%'],
    ['one encoded slash deeper in the path', '/setter/a%2Fb'],
    ['encoded URL in the query', '/gym/x?next=https%3A%2F%2Fexample.com%2F%2Fpath'],
    ['nested sign-in return in the query', '/auth/login?callbackUrl=%2Fb%2Fthe-garage%3Finvite%3Dabc'],
    ['encoded newline in the query', '/gym/x?note=a%0Ab'],
    ['native callback path', '/api/auth/native/callback?next=%2F&provider=google&attemptId=abc'],
  ])('keeps a real return path: %s', (_label, callbackUrl) => {
    expect(safeCallbackUrl(callbackUrl)).toBe(callbackUrl);
    expect(safeCallbackUrl(callbackUrl, SITE_ORIGIN)).toBe(callbackUrl);
  });

  describe('a double slash the locale router would expose', () => {
    const doubleSlashForms = [
      '/es//evil.example',
      '/fr//',
      '/de//',
      '/it//',
      '/es/fr//',
      '/es/\\evil.example',
      '/.//evil.example',
      '/..//evil.example',
      '/%2e//evil.example',
      '/es/%2F/evil.example',
      '/es/%5Cevil.example',
      '/a%2F%2Fb',
    ];

    it.each(doubleSlashForms)('rejects %s', (callbackUrl) => {
      expect(safeCallbackUrl(callbackUrl)).toBe('/');
      expect(safeCallbackUrl(callbackUrl, SITE_ORIGIN)).toBe('/');
    });

    it.each(SUPPORTED_LOCALES)('stays on this site through the real applyLocale in %s', (locale) => {
      for (const callbackUrl of doubleSlashForms) {
        const routedHref = applyLocale(safeCallbackUrl(callbackUrl, SITE_ORIGIN), locale);
        expect(new URL(routedHref, SITE_ORIGIN).origin).toBe(SITE_ORIGIN);
      }
    });

    it('does not reject a double slash in the query', () => {
      expect(safeCallbackUrl('/gym/x?next=https://example.com')).toBe('/gym/x?next=https://example.com');
    });
  });

  describe('absolute URLs on the current origin', () => {
    it('keeps the whole URL, as NextAuth sends it to the login page', () => {
      const returnUrl = `${SITE_ORIGIN}/gym/bloclab/manage?claim=1#top`;
      expect(safeCallbackUrl(returnUrl, SITE_ORIGIN)).toBe(returnUrl);
      const nativeCallback = `${SITE_ORIGIN}/api/auth/native/callback?next=%2F&provider=google&attemptId=abc`;
      expect(safeCallbackUrl(nativeCallback, SITE_ORIGIN)).toBe(nativeCallback);
      expect(safeCallbackUrl(SITE_ORIGIN, SITE_ORIGIN)).toBe(`${SITE_ORIGIN}/`);
    });

    it.each([`${SITE_ORIGIN}//evil.example`, `${SITE_ORIGIN}/.//evil.example`, `${SITE_ORIGIN}/es//evil.example`])(
      'rejects %s, whose path has a double slash',
      (callbackUrl) => {
        expect(safeCallbackUrl(callbackUrl, SITE_ORIGIN)).toBe('/');
      },
    );

    it('is not accepted unless the caller names the origin', () => {
      expect(safeCallbackUrl(`${SITE_ORIGIN}/gym/bloclab`)).toBe('/');
    });

    it.each([
      ['another site', 'https://evil.example/'],
      ['the Expo app origin', 'https://app.boardsesh.com/auth/login'],
      ['another subdomain', 'https://evil.boardsesh.com/'],
      ['a look-alike suffix', 'https://www.boardsesh.com.evil.example/'],
      ['a look-alike userinfo', 'https://www.boardsesh.com@evil.example/'],
      ['credentials on the right host', 'https://user:secret@www.boardsesh.com/'],
      ['plain http', 'http://www.boardsesh.com/'],
      ['another port', 'https://www.boardsesh.com:8443/'],
      ['a blob URL on this origin', 'blob:https://www.boardsesh.com/0b5c2c0e'],
      ['a slashless scheme', 'https:evil.example'],
      ['a control character in the host', 'https://www.boardsesh.com\t.evil.example/'],
      ['a javascript URL', 'javascript:alert(document.domain)'],
    ])('rejects %s', (_label, callbackUrl) => {
      expect(safeCallbackUrl(callbackUrl, SITE_ORIGIN)).toBe('/');
    });
  });
});
