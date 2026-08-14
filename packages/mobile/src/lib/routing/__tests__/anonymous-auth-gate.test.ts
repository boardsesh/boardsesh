// The native-unchanged guarantee, at module level.
//
// This PR auto-OTAs to every installed binary on merge to `main`, so "the web
// relaxation cannot reach native" has to be an assertion, not an argument.
// Vitest has no `.web` extension resolution (see `packages/mobile/vite.config.ts`,
// whose alias list spells out every platform split), so the bare import below IS
// the native fork — the same module Metro hands the store fleet.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildLoginHrefWithReturn,
  isAnonymousReadOnlyLocation,
  readPostLoginReturnHref,
  RELAXES_ANONYMOUS_ROUTES,
} from '../anonymous-auth-gate';
import { CLIMB_SEGMENT, GATED_PATHS, READ_ONLY_PATHS } from './read-only-route-corpus';

const ALL_PATHS = [...READ_ONLY_PATHS, ...GATED_PATHS];

/** Stand a `window.location` up so a fork that reads one has something to read. */
function atLocation(pathname: string, search = '') {
  vi.stubGlobal('window', { location: { pathname, search, origin: 'https://app.boardsesh.com' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anonymous-auth-gate (native fork)', () => {
  it('declares that native relaxes nothing', () => {
    expect(RELAXES_ANONYMOUS_ROUTES).toBe(false);
  });

  // Driven through a stubbed location on purpose: passing every relaxed path and
  // still getting `false` proves the fork ignores the address bar entirely,
  // rather than merely happening to be false in this environment.
  it.each(ALL_PATHS)('never relaxes the gate at %s', (path) => {
    atLocation(path);
    expect(isAnonymousReadOnlyLocation()).toBe(false);
  });

  it.each(ALL_PATHS)('hands back the bare login route at %s', (path) => {
    atLocation(path);
    expect(buildLoginHrefWithReturn()).toBe('/auth/login');
  });

  it('reads no return href, even with a valid next in the query', () => {
    atLocation(`/b/the-gym/40/view/${CLIMB_SEGMENT}`, `?next=/b/the-gym/40/view/${CLIMB_SEGMENT}`);
    expect(readPostLoginReturnHref()).toBeNull();
  });

  it('reads no return href with no window at all', () => {
    expect(readPostLoginReturnHref()).toBeNull();
  });
});

describe('anonymous-auth-gate fork parity', () => {
  // The web AuthProvider suite substitutes the web fork for the native one via
  // `vi.mock`. That substitution is only faithful while both forks export the
  // same symbols — so a symbol added to one and forgotten in the other fails
  // here rather than silently at runtime on one platform.
  it('exports the same symbols from both forks', async () => {
    const nativeFork = await import('../anonymous-auth-gate');
    const webFork = await import('../anonymous-auth-gate.web');
    expect(Object.keys(webFork).sort()).toEqual(Object.keys(nativeFork).sort());
  });
});
