import { describe, it, expect } from 'vitest';
import { isReadOnlyAnonymousPath, isSafeReturnPath, MAX_RETURN_HREF_LENGTH } from '../read-only-routes';
import { CLIMB_SEGMENT, CLIMB_UUID, GATED_PATHS, READ_ONLY_PATHS, TUPLE } from './read-only-route-corpus';

describe('isReadOnlyAnonymousPath', () => {
  it.each(READ_ONLY_PATHS)('relaxes %s', (path) => {
    expect(isReadOnlyAnonymousPath(path)).toBe(true);
  });

  it.each(GATED_PATHS)('keeps %s gated', (path) => {
    expect(isReadOnlyAnonymousPath(path)).toBe(false);
  });

  // The www front door appends campaign params to shared links, and the browser
  // keeps the fragment. Neither changes which route the URL names.
  it.each([
    '/b/the-gym/40/list?utm_source=newsletter',
    '/b/the-gym/40/list#holds',
    `${TUPLE}/40/view/${CLIMB_SEGMENT}?page=2#beta`,
  ])('ignores the query/hash tail on %s', (path) => {
    expect(isReadOnlyAnonymousPath(path)).toBe(true);
  });

  it('tolerates a trailing slash', () => {
    expect(isReadOnlyAnonymousPath('/b/the-gym/40/list/')).toBe(true);
  });

  // Named, literal, corpus-independent: the player route stays gated.
  //
  // The anonymous climb renders IN PLACE on its `/…/{angle}/view/{segment}` URL
  // precisely so `/play` never has to open anonymously. The cheap way to "fix"
  // a future bug in that flow is to move `/play` from GATED_PATHS into
  // READ_ONLY_PATHS — and every corpus-driven suite here, in both fork suites
  // and in both AuthProvider gate suites, is an `it.each` over whichever array
  // now holds it, so all of them would stay green while the whole player route
  // became reachable from a typed URL. Only a named literal goes red.
  it('never relaxes the player route or the legacy climb redirector', () => {
    expect(isReadOnlyAnonymousPath('/play')).toBe(false);
    expect(isReadOnlyAnonymousPath(`/climbs/${CLIMB_UUID}`)).toBe(false);
    expect(isReadOnlyAnonymousPath('/(tabs)/climbs')).toBe(false);
  });

  // The locale has to be a whole segment — `stripLocalePrefix`'s rule. Chopping
  // `es` off `estonia` would relax a route nobody asked for.
  it.each(['/estonia/kilter/1/10/1,20/40/list', '/esp/b/the-gym/40/list'])(
    'does not treat %s as locale-prefixed',
    (path) => {
      expect(isReadOnlyAnonymousPath(path)).toBe(false);
    },
  );
});

describe('isSafeReturnPath', () => {
  it('accepts an app-relative board path', () => {
    expect(isSafeReturnPath(`/b/the-gym/40/view/${CLIMB_SEGMENT}`)).toBe(true);
  });

  // One rejection test each for the open-redirect shapes. `\t` and the backslash
  // forms are the ones that survive a naive "starts with /" check: browsers trim
  // leading whitespace and normalise `\` to `/` before navigating.
  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a protocol-relative URL', '//evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a mixed-case scheme', 'JaVaScRiPt:alert(1)'],
    ['a backslash escape', '/\\evil.example'],
    ['a double backslash', '\\\\evil.example'],
    ['a leading tab', '\t/b/the-gym/40/list'],
    ['a leading newline', '\n//evil.example'],
    ['a relative path', 'b/the-gym/40/list'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isSafeReturnPath(value)).toBe(false);
  });

  it('rejects a path past the length cap', () => {
    expect(isSafeReturnPath(`/b/${'a'.repeat(MAX_RETURN_HREF_LENGTH)}`)).toBe(false);
  });

  // `%2f%2fevil.example` arrives here already decoded — `URLSearchParams.get`
  // decodes once — so the protocol-relative rule is what catches it.
  it('rejects a percent-decoded protocol-relative value', () => {
    expect(isSafeReturnPath(decodeURIComponent('%2f%2fevil.example'))).toBe(false);
  });

  // These pass every literal rule and the board-shape check, then the router
  // decodes them into `/es//evil.example/…` and `+not-found` strips the locale.
  it.each([
    ['a hidden slash', '/es/%252Fevil.example/a/b/c/40/list'],
    ['a slash one layer deeper', '/es/%25252Fevil.example/a/b/c/40/list'],
    ['a hidden backslash', '/es/%255Cevil.example/a/b/c/40/list'],
    ['a hidden tab', '/es/%2509/a/b/c/40/list'],
    ['a literal empty segment', '/es//evil.example/a/b/c/40/list'],
  ])('rejects %s that the router would decode into a redirect', (_label, value) => {
    expect(isSafeReturnPath(value)).toBe(false);
  });

  // The encodings a real board URL carries keep working.
  it.each(['/kilter/1/10/1%2C20/40/list', '/b/caf%C3%A9-wall/40/list', `/es/b/the-gym/40/view/${CLIMB_SEGMENT}`])(
    'accepts %s',
    (value) => {
      expect(isSafeReturnPath(value)).toBe(true);
    },
  );

  // Tighter than the router's check on purpose, and only here: a return path is a
  // board URL we minted.
  it.each(['/b/the gym/40/list', '/b/the-gym/40/list?ref=a b', '/b/the-gym/40/list?ref=a\\b'])(
    'rejects %s, which we would never mint',
    (value) => {
      expect(isSafeReturnPath(value)).toBe(false);
    },
  );
});
