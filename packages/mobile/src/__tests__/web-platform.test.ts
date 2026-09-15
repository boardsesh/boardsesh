import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWebHeadOrigin, resolveWebPlatforms } from '../../app.config';

describe('resolveWebPlatforms', () => {
  const originalBaseUrl = process.env.BOARDSESH_WEB_BASE_URL;

  beforeEach(() => {
    delete process.env.BOARDSESH_WEB_BASE_URL;
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.BOARDSESH_WEB_BASE_URL;
    } else {
      process.env.BOARDSESH_WEB_BASE_URL = originalBaseUrl;
    }
  });

  it('preserves the mobile-only config when the flag is unset', () => {
    const resolution = resolveWebPlatforms(undefined);

    expect(resolution).toEqual({ platforms: ['ios', 'android'] });
    expect('web' in resolution).toBe(false);
    expect('baseUrl' in resolution).toBe(false);
  });

  it('never returns a router key off web (fingerprint-critical)', () => {
    // `router.asyncRoutes` is merged into `extra.router`, and `extra` is part of
    // the resolved Expo config that @expo/fingerprint hashes. If it leaked out
    // of the web branch, every native runtime version would change and the whole
    // store fleet would stop accepting OTA updates until a new binary shipped.
    // Verified out-of-band by resolving the runtime version with and without
    // this change: ios and android hashes were identical.
    expect('router' in resolveWebPlatforms(undefined)).toBe(false);
    expect('router' in resolveWebPlatforms('0')).toBe(false);
  });

  it('ignores BOARDSESH_WEB_BASE_URL when web is disabled (fingerprint-critical)', () => {
    // Native builds leave BOARDSESH_WEB unset; the base-URL knob must never
    // perturb their resolved config, so the mobile-only shape stays identical.
    process.env.BOARDSESH_WEB_BASE_URL = '/';

    const resolution = resolveWebPlatforms(undefined);

    expect(resolution).toEqual({ platforms: ['ios', 'android'] });
    expect('baseUrl' in resolution).toBe(false);
  });

  it.each(['', '0', 'true', 'web', ' 1'])('does not enable web for %j', (envValue) => {
    expect(resolveWebPlatforms(envValue)).toEqual({ platforms: ['ios', 'android'] });
  });

  it('enables a single-page Metro export rooted at /app by default', () => {
    expect(resolveWebPlatforms('1')).toEqual({
      platforms: ['ios', 'android', 'web'],
      web: { output: 'single', bundler: 'metro' },
      baseUrl: '/app',
      router: { asyncRoutes: true },
    });
  });

  // A bare '/' must normalize to '', never pass through. Expo prepends the base
  // to every asset path, so '/' yields '//assets/...', which browsers resolve as
  // the HOST `assets` — every icon font and board background fails to load on
  // app.boardsesh.com while root-absolute /_expo/* JS and CSS keep working.
  it('serves at the origin root when BOARDSESH_WEB_BASE_URL=/ (subdomain export)', () => {
    process.env.BOARDSESH_WEB_BASE_URL = '/';

    expect(resolveWebPlatforms('1')).toEqual({
      platforms: ['ios', 'android', 'web'],
      web: { output: 'single', bundler: 'metro' },
      baseUrl: '',
      router: { asyncRoutes: true },
    });
  });
});

describe('resolveWebHeadOrigin', () => {
  it('is absent from native config when web is disabled', () => {
    expect(resolveWebHeadOrigin(undefined, 'https://example.test:3000/app')).toBeUndefined();
  });

  it('allows Metro requests from the public same-origin web host', () => {
    expect(resolveWebHeadOrigin('1', 'https://example.test:3000/app')).toBe('https://example.test:3000');
  });

  it('rejects non-HTTP public origins', () => {
    expect(() => resolveWebHeadOrigin('1', 'file:///tmp/app')).toThrow(/http or https/);
  });
});
