import { describe, expect, it } from 'vitest';
import { isSameOriginPath } from '../same-origin-path';

describe('isSameOriginPath', () => {
  it.each([
    '/',
    '/(tabs)/home',
    '/kilter/1/10/1,20/40/list',
    '/b/the-gym/40/list/',
    '/setter/Some Climber',
    '/setter/José',
    '/setter/Jos%C3%A9',
    '/kilter/1/10/1%2C20/40/list',
    '/setter/Some%2520Climber',
    // A climb named "100% Crimps": the router's decode leaves this malformed
    // escape alone, so it is ordinary text.
    '/setter/100%',
    '/b/100%-crimps/40/list',
  ])('accepts %s', (path) => {
    expect(isSameOriginPath(path)).toBe(true);
  });

  // The query and fragment cannot change the origin, and a real one carries a URL.
  it.each([
    '/share-beta?link=https%3A%2F%2Finstagram.com%2Freel%2Fabc',
    '/share-beta?link=https://instagram.com/reel/abc',
    '/join/abc123?src=qr#top',
    '/?src=qr',
  ])('judges only the path of %s', (href) => {
    expect(isSameOriginPath(href)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a relative path', 'kilter/1/10'],
    ['an absolute URL', 'https://evil.example/x'],
    ['a scheme without slashes', 'javascript:alert(1)'],
    ['a query with no path', '?next=/home'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['three slashes', '///evil.example/x'],
    ['a backslash after the slash', '/\\evil.example/x'],
    ['an empty segment mid-path', '/es//evil.example/x'],
    ['a tab', '/\t/evil.example'],
    ['a newline', '/\n/evil.example'],
    ['DEL', '/\u007f/evil.example'],
  ])('refuses %s', (_label, value) => {
    expect(isSameOriginPath(value)).toBe(false);
  });

  it.each([
    ['one layer of %2F', '/%2Fevil.example/x'],
    ['two layers of %2F', '/%252Fevil.example/x'],
    ['three layers of %2F', '/%25252Fevil.example/x'],
    ['lower-case hex', '/%2fevil.example/x'],
    ['a locale in front', '/es/%252Fevil.example/x'],
    ['a dot segment in front', '/a/../%252Fevil.example'],
    ['one layer of backslash', '/%5Cevil.example/x'],
    ['two layers of backslash', '/%255Cevil.example/x'],
    ['one layer of tab', '/%09/evil.example'],
    ['two layers of newline', '/%250A/evil.example'],
    // `?` hides nothing once it has been decoded out of the path.
    ['a slash behind a decoded question mark', '/es/%253F%252F%252Fevil.example'],
  ])('refuses %s', (_label, path) => {
    expect(isSameOriginPath(path)).toBe(false);
  });

  // A malformed escape in one segment must not stop the next one being decoded:
  // Expo Router decodes segment by segment, so a whole-string decode that threw
  // here would have passed this value on undecoded.
  it('still decodes the rest of the path around a malformed escape', () => {
    expect(isSameOriginPath('/es/%252Fevil.example/%zz')).toBe(false);
    expect(isSameOriginPath('/%zz/%252Fevil.example')).toBe(false);
  });

  it('accepts a value that settles within the passes and refuses one that does not', () => {
    expect(isSameOriginPath('/a%252541')).toBe(true);
    expect(isSameOriginPath(`/a%${'25'.repeat(10)}41`)).toBe(false);
  });
});
