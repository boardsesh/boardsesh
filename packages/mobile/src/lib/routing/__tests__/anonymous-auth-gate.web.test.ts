// @vitest-environment jsdom
//
// The web fork, imported by its explicit `.web` path — vitest resolves the bare
// specifier to the native fork, so this suite is the only thing that exercises
// the code app.boardsesh.com actually runs.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildLoginHrefWithReturn,
  isAnonymousReadOnlyLocation,
  readPostLoginReturnHref,
  RELAXES_ANONYMOUS_ROUTES,
} from '../anonymous-auth-gate.web';
import { CLIMB_SEGMENT, GATED_PATHS, READ_ONLY_PATHS } from './read-only-route-corpus';

/** Move the jsdom address bar, which is what the fork reads. */
function goTo(url: string) {
  window.history.replaceState({}, '', url);
}

afterEach(() => {
  vi.unstubAllEnvs();
  goTo('/');
});

describe('anonymous-auth-gate (web fork)', () => {
  it('declares that web relaxes the gate', () => {
    expect(RELAXES_ANONYMOUS_ROUTES).toBe(true);
  });

  it.each(READ_ONLY_PATHS)('relaxes the gate at %s', (path) => {
    goTo(path);
    expect(isAnonymousReadOnlyLocation()).toBe(true);
  });

  it.each(GATED_PATHS)('leaves the gate standing at %s', (path) => {
    goTo(path);
    expect(isAnonymousReadOnlyLocation()).toBe(false);
  });

  it.each(READ_ONLY_PATHS)('carries %s into the login href', (path) => {
    goTo(path);
    expect(buildLoginHrefWithReturn()).toBe(`/auth/login?next=${encodeURIComponent(path)}`);
  });

  // The redirect-loop guard: a gated path — `/auth/login` included — gets the
  // bare login route, so a `next` can never name an auth route.
  it.each(GATED_PATHS)('hands back the bare login route at %s', (path) => {
    goTo(path);
    expect(buildLoginHrefWithReturn()).toBe('/auth/login');
  });

  // The query is deliberately not carried: the canonical board URLs have no
  // meaningful one, and dropping it stops `bs_oauth_*` residue riding along.
  it('carries the path only, not the query', () => {
    goTo('/b/the-gym/40/list?boardseshOAuthProvider=google');
    expect(buildLoginHrefWithReturn()).toBe(`/auth/login?next=${encodeURIComponent('/b/the-gym/40/list')}`);
  });
});

describe('readPostLoginReturnHref', () => {
  it('returns a valid board path', () => {
    const next = `/b/the-gym/40/view/${CLIMB_SEGMENT}`;
    goTo(`/auth/login?next=${encodeURIComponent(next)}`);
    expect(readPostLoginReturnHref()).toBe(next);
  });

  it.each([
    ['an absolute URL', 'https://evil.example'],
    ['a protocol-relative URL', '//evil.example'],
    ['a double-encoded protocol-relative URL', '%2f%2fevil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a backslash escape', '/%5Cevil.example'],
    // App-relative and perfectly safe, but outside the set the gate can produce.
    // The second gate is what stops a hand-crafted next reaching any in-app route.
    ['an in-app route outside the allow-set', '/(tabs)/profile'],
  ])('drops %s', (_label, next) => {
    goTo(`/auth/login?next=${next}`);
    expect(readPostLoginReturnHref()).toBeNull();
  });

  it('returns null when there is no next at all', () => {
    goTo('/auth/login');
    expect(readPostLoginReturnHref()).toBeNull();
  });

  // Login forwards `next` to the sign-up screen as an Expo Router param, which
  // lands in the address bar. Reading it back is what makes "register instead of
  // signing in" return to the same climb — and it is also what
  // `startWebOAuth` reads when someone taps "Continue with Google" from there.
  it('reads the same next off the register screen', () => {
    const next = `/b/the-gym/40/view/${CLIMB_SEGMENT}`;
    goTo(`/auth/register?next=${encodeURIComponent(next)}`);
    expect(readPostLoginReturnHref()).toBe(next);
  });
});

// `EXPO_BASE_URL` is `/app` on the www-mounted export and `/` on the
// app.boardsesh.com subdomain export. `window.location.pathname` carries it;
// the router path does not, and neither does the `next` we hand back.
describe('EXPO_BASE_URL base stripping', () => {
  it('relaxes a based path and emits a base-relative next', () => {
    vi.stubEnv('EXPO_BASE_URL', '/app');
    goTo('/app/b/the-gym/40/list');
    expect(isAnonymousReadOnlyLocation()).toBe(true);
    expect(buildLoginHrefWithReturn()).toBe(`/auth/login?next=${encodeURIComponent('/b/the-gym/40/list')}`);
  });

  it('does not relax the mount point itself', () => {
    vi.stubEnv('EXPO_BASE_URL', '/app');
    goTo('/app');
    expect(isAnonymousReadOnlyLocation()).toBe(false);
    expect(buildLoginHrefWithReturn()).toBe('/auth/login');
  });
});
