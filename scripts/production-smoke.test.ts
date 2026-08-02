/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { FIXTURE_PATHS, WWW_CHECKS, type SmokeResponse } from './production-smoke';

// The assertions are the whole product here: the runner is a retry loop, but
// the check table is what decides whether a broken deploy is caught. These
// tests exist so a check can't be silently weakened into a tautology — every
// one of them must reject at least one realistic failure, not just accept a
// healthy response.

function response(overrides: Partial<SmokeResponse> = {}): SmokeResponse {
  return { status: 200, contentType: 'text/html; charset=utf-8', body: '<h1>Boardsesh</h1>', ...overrides };
}

/**
 * Ambiguity is a failure, not a first-match. "sitemap" matches both the sitemap
 * check and the robots check that points at it, and silently resolving to the
 * wrong one means these assertions would pass while testing nothing.
 */
function checkNamed(fragment: string) {
  const matches = WWW_CHECKS.filter((check) => check.name.includes(fragment));
  if (matches.length === 0) throw new Error(`no check matching "${fragment}"`);
  if (matches.length > 1) {
    throw new Error(`"${fragment}" is ambiguous: ${matches.map((check) => check.name).join(' | ')}`);
  }
  return matches[0];
}

describe('www production smoke checks', () => {
  it('covers the surfaces other systems depend on', () => {
    const paths = WWW_CHECKS.filter((check) => !check.fixtureEnvVar).map((check) => check.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/', '/robots.txt', '/sitemap.xml', '/api/auth/session', '/api/internal/ws-auth']),
    );
  });

  it('rejects a homepage that 200s with a spinner-only shell', () => {
    const check = checkNamed('homepage');
    expect(check.assert(response())).toBeNull();
    // The exact regression this catches: real status, real content type, no SSR.
    expect(check.assert(response({ body: '<div id="root"></div>' }))).toMatch(/<h1>/);
    expect(check.assert(response({ status: 500 }))).toMatch(/500/);
  });

  it('rejects a robots.txt with no sitemap directive', () => {
    const check = checkNamed('robots.txt serves');
    const healthy = response({ contentType: 'text/plain', body: 'User-agent: *\nSitemap: https://x/sitemap.xml\n' });
    expect(check.assert(healthy)).toBeNull();
    expect(check.assert(response({ contentType: 'text/plain', body: 'User-agent: *\n' }))).toMatch(/Sitemap/);
  });

  it('rejects an empty sitemap', () => {
    const check = checkNamed('sitemap.xml serves');
    expect(
      check.assert(response({ contentType: 'application/xml', body: '<urlset><loc>x</loc></urlset>' })),
    ).toBeNull();
    expect(check.assert(response({ contentType: 'application/xml', body: '<urlset></urlset>' }))).toMatch(/loc/);
  });

  it('rejects a session endpoint that 200s with an error payload', () => {
    const check = checkNamed('auth session');
    expect(check.assert(response({ contentType: 'application/json', body: '{}' }))).toBeNull();
    // NextAuth answers 200 for an anonymous session, so status alone proves
    // nothing here — the body is the only place a failure shows up.
    expect(check.assert(response({ contentType: 'application/json', body: '{"error":"db down"}' }))).toMatch(/db down/);
    expect(check.assert(response({ contentType: 'application/json', body: '<html>502</html>' }))).toMatch(
      /not valid JSON/,
    );
  });

  it('rejects a ws-auth response that is not the anonymous payload shape', () => {
    const check = checkNamed('ws-auth');
    const healthy = response({
      contentType: 'application/json',
      body: JSON.stringify({ token: null, authenticated: false }),
    });
    expect(check.assert(healthy)).toBeNull();
    // A 200 that returns an error page instead of JSON — the shape a proxy
    // misconfiguration produces, and the one a status-only check would miss.
    expect(check.assert(response({ contentType: 'application/json', body: 'Internal Server Error' }))).toMatch(
      /not valid JSON/,
    );
    expect(check.assert(response({ contentType: 'application/json', body: '{"ok":true}' }))).toMatch(/authenticated/);
    expect(check.assert(response({ status: 401, contentType: 'application/json', body: '{}' }))).toMatch(/401/);
  });

  it('skips fixture-backed checks rather than failing when the fixture is unset', () => {
    // Fail-closed on missing config is how #3977 stopped production deploys for
    // two days. Every fixture-backed check must declare its env var and have a
    // path builder, so an unset var is a skip and never a red deploy.
    const fixtureChecks = WWW_CHECKS.filter((check) => check.fixtureEnvVar);
    expect(fixtureChecks.length).toBeGreaterThan(0);
    for (const check of fixtureChecks) {
      expect(FIXTURE_PATHS[check.fixtureEnvVar as string], `${check.name} has no path builder`).toBeDefined();
    }
  });

  it('builds fixture paths from the configured value', () => {
    expect(FIXTURE_PATHS.SMOKE_KIOSK_GYM_SLUG('movement-lu')).toBe('/kiosk/movement-lu');
    expect(FIXTURE_PATHS.SMOKE_EMBED_BOARD_UUID('abc-123')).toBe('/embed/board/abc-123');
  });
});
