// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import {
  OIDC_STAND_IN_REFUSED,
  OIDC_STAND_IN_ENV,
  oidcStandInBootRefusal,
  oidcStandInWellKnown,
} from '../oidc-stand-in.server';

/**
 * The browser-session e2e run's provider stand-ins (#7596 B7c): the one way to
 * point www's Google or Apple provider at a loopback OpenID provider, and only
 * on the reserved `.boardsesh.test` origins. Anywhere else it is refused and
 * www does not boot.
 */
const TEST_SITE = { NEXTAUTH_URL: 'https://www.boardsesh.test' };
const STAND_IN = 'http://127.0.0.1:41234/.well-known/openid-configuration';

describe('oidcStandInWellKnown', () => {
  it('is undefined when unset or empty, on any origin', () => {
    for (const site of [TEST_SITE, { NEXTAUTH_URL: 'https://www.boardsesh.com' }, {}]) {
      expect(oidcStandInWellKnown('apple', site)).toBeUndefined();
      expect(oidcStandInWellKnown('google', { ...site, [OIDC_STAND_IN_ENV.google]: '' })).toBeUndefined();
      expect(oidcStandInBootRefusal(site)).toBeUndefined();
    }
  });

  it('points a provider at a loopback stand-in on a .boardsesh.test https origin', () => {
    const environment = { ...TEST_SITE, [OIDC_STAND_IN_ENV.apple]: STAND_IN };
    expect(oidcStandInWellKnown('apple', environment)).toBe(STAND_IN);
    expect(oidcStandInWellKnown('google', environment)).toBeUndefined();
    expect(oidcStandInBootRefusal(environment)).toBeUndefined();
  });

  it.each([
    ['the production origin', { NEXTAUTH_URL: 'https://www.boardsesh.com' }],
    ['a preview origin', { NEXTAUTH_URL: 'https://1234.preview.boardsesh.com' }],
    ['local http', { NEXTAUTH_URL: 'http://localhost:3000' }],
    ['plain http on the test domain', { NEXTAUTH_URL: 'http://www.boardsesh.test' }],
    ['a look-alike host', { NEXTAUTH_URL: 'https://www.boardsesh.test.example.com' }],
    ['no origin', {}],
    ['a hosted deployment on the test domain', { ...TEST_SITE, RAILWAY_ENVIRONMENT_ID: 'production' }],
    ['a Vercel build on the test domain', { ...TEST_SITE, VERCEL: '1' }],
  ])('is refused on %s, and refuses the boot', (_case, site) => {
    for (const provider of ['apple', 'google'] as const) {
      const environment = { ...site, [OIDC_STAND_IN_ENV[provider]]: STAND_IN };
      expect(() => oidcStandInWellKnown(provider, environment)).toThrow(OIDC_STAND_IN_REFUSED);
      expect(oidcStandInBootRefusal(environment)).toEqual(new Error(OIDC_STAND_IN_REFUSED));
    }
  });

  it.each([
    'https://appleid.apple.com/.well-known/openid-configuration',
    'http://10.0.0.5/x',
    'not a url',
    'ftp://127.0.0.1/',
  ])('refuses a stand-in that is not a loopback http(s) URL (%s)', (value) => {
    const environment = { ...TEST_SITE, [OIDC_STAND_IN_ENV.apple]: value };
    expect(() => oidcStandInWellKnown('apple', environment)).toThrow(OIDC_STAND_IN_REFUSED);
    expect(oidcStandInBootRefusal(environment)).toEqual(new Error(OIDC_STAND_IN_REFUSED));
  });
});
