import { describe, expect, it } from 'vite-plus/test';
import { PARTNER_DEVELOPER_TERMS_VERSION } from '@boardsesh/auth-protocol/partner-oauth';
import { readPartnerAuthorityConfiguration } from '../configuration';
import {
  isDraftDeveloperTermsVersion,
  normalizePartnerAppInput,
  normalizePartnerAppPatch,
  PARTNER_APP_NAME_DENYLIST,
  parsePartnerDeveloperAllowlist,
  partnerRedirectUriProblem,
  PartnerRegistrationError,
  validatePartnerAppLink,
  validatePartnerAppName,
  validatePartnerPublisherName,
  validatePartnerRedirectUris,
} from '../registration-rules';

function refusalMessage(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof PartnerRegistrationError && error.reason === 'invalid_input') return error.message;
    throw error;
  }
  throw new Error('Expected an invalid_input refusal');
}

describe('redirect URIs', () => {
  it.each([
    ['https://app.example.com/oauth/boardsesh', 'web'],
    ['https://app.example.com/oauth/boardsesh', 'native'],
    ['https://app.example.com:8443/cb?tab=connect', 'web'],
    ['https://boardsesh.com.example.net/cb', 'web'],
    ['https://example.net/boardsesh.com/cb', 'web'],
    ['http://127.0.0.1/callback', 'native'],
    ['http://127.0.0.1:53117/callback', 'native'],
    ['http://[::1]/callback', 'native'],
    ['http://[::1]:8080/callback', 'native'],
    ['com.example.app:/oauth/boardsesh', 'native'],
    ['com.example.app:/', 'native'],
    ['com.example.app://oauth.example.com/callback', 'native'],
    ['io.github.climber-tools:/cb', 'native'],
  ] as const)('allows %s for a %s app', (uri, applicationType) => {
    expect(partnerRedirectUriProblem(uri, applicationType)).toBeNull();
  });

  it.each([
    // http only on loopback literals, and only for native apps.
    ['http://127.0.0.1/callback', 'web', /web app can only use https/],
    ['http://app.example.com/cb', 'native', /only allowed on the loopback/],
    ['http://localhost/callback', 'native', /only allowed on the loopback/],
    ['http://localhost:8080/callback', 'native', /only allowed on the loopback/],
    ['http://127.0.0.2/callback', 'native', /only allowed on the loopback/],
    ['http://[::ffff:7f00:1]/callback', 'native', /only allowed on the loopback/],
    ['http://0.0.0.0/callback', 'native', /only allowed on the loopback/],
    // https on a loopback host is neither a web redirect nor RFC 8252 loopback.
    ['https://localhost/callback', 'native', /loopback redirect URI must use http/],
    ['https://127.0.0.1/callback', 'native', /loopback redirect URI must use http/],
    ['https://[::1]/callback', 'web', /loopback redirect URI must use http/],
    ['https://app.localhost/callback', 'web', /loopback redirect URI must use http/],
    // Boardsesh's own hosts and schemes.
    ['https://boardsesh.com/cb', 'web', /boardsesh\.com/],
    ['https://www.boardsesh.com/oauth/consent', 'web', /boardsesh\.com/],
    ['https://api.boardsesh.com/api/auth/error', 'native', /boardsesh\.com/],
    ['https://boardsesh.com./cb', 'web', /boardsesh\.com/],
    ['com.boardsesh.app:/oauth', 'native', /Boardsesh scheme/],
    ['com.boardsesh:/oauth', 'native', /Boardsesh scheme/],
    ['app.boardsesh.fake:/oauth', 'native', /Boardsesh scheme/],
    ['boardsesh:/oauth', 'native', /reverse domain name/],
    // Private-use schemes: native only, reverse-domain, with a path.
    ['com.example.app:/oauth/boardsesh', 'web', /web app can only use https/],
    ['myapp://callback/path', 'native', /reverse domain name/],
    ['myapp:/callback', 'native', /reverse domain name/],
    ['com.example.app://callback', 'native', /needs a path/],
    ['com.example.app:callback', 'native', /needs a path/],
    // Reserved and dangerous schemes.
    ['javascript:alert(1)', 'native', /reverse domain name/],
    ['data:text/html,hi', 'native', /reverse domain name/],
    ['file:///etc/passwd', 'native', /reverse domain name/],
    ['ws://127.0.0.1/cb', 'native', /reverse domain name/],
    ['ftp://example.com/cb', 'web', /web app can only use https/],
    // Exact strings: fragments, wildcards, credentials and non-canonical forms.
    ['https://app.example.com/cb#done', 'web', /fragment/],
    ['https://app.example.com/cb#', 'web', /fragment/],
    ['https://*.example.com/cb', 'web', /wildcard/],
    ['https://app.example.com/*', 'web', /wildcard/],
    ['https://user:pass@app.example.com/cb', 'web', /user name or password/],
    ['https://user@app.example.com/cb', 'web', /user name or password/],
    ['https://App.Example.com/cb', 'web', /Write this redirect URI as https:\/\/app\.example\.com\/cb/],
    ['https://app.example.com', 'web', /Write this redirect URI as https:\/\/app\.example\.com\//],
    ['https://app.example.com:443/cb', 'web', /Write this redirect URI as/],
    ['https://app.example.com/a/../cb', 'web', /Write this redirect URI as/],
    ['HTTP://127.0.0.1/cb', 'native', /Write this redirect URI as/],
    ['Com.Example.App:/cb', 'native', /Write this redirect URI as/],
    ['https://app.example.com/c b', 'web', /spaces or control/],
    ['https://app.example.com/cb\u0000', 'web', /spaces or control/],
    ['https://app.example.com/cb​', 'web', /spaces or control/],
    ['/relative/callback', 'web', /not an absolute URI/],
    ['', 'web', /1 to 2048 characters/],
    [`https://app.example.com/${'a'.repeat(2048)}`, 'web', /1 to 2048 characters/],
  ] as const)('refuses %s for a %s app', (uri, applicationType, reason) => {
    expect(partnerRedirectUriProblem(uri, applicationType)).toMatch(reason);
  });

  it('caps the list at ten, and refuses an empty list, a repeat or a non-string', () => {
    const uris = (count: number) => Array.from({ length: count }, (_, index) => `https://app.example.com/cb/${index}`);
    expect(validatePartnerRedirectUris(uris(10), 'web')).toHaveLength(10);
    expect(refusalMessage(() => validatePartnerRedirectUris(uris(11), 'web'))).toMatch(/at most 10/);
    expect(refusalMessage(() => validatePartnerRedirectUris([], 'web'))).toMatch(/at least one/);
    expect(
      refusalMessage(() =>
        validatePartnerRedirectUris(['https://a.example.com/cb', 'https://a.example.com/cb'], 'web'),
      ),
    ).toMatch(/listed twice/);
    expect(refusalMessage(() => validatePartnerRedirectUris('https://a.example.com/cb', 'web'))).toMatch(/list/);
    expect(refusalMessage(() => validatePartnerRedirectUris([42], 'web'))).toMatch(/list of strings/);
  });
});

describe('app names', () => {
  it('builds the denylist from Boardsesh, Aurora and every board brand but the spray wall', () => {
    expect(PARTNER_APP_NAME_DENYLIST).toEqual(
      expect.arrayContaining([
        'Boardsesh',
        'Aurora',
        'Kilter',
        'Tension',
        'MoonBoard',
        'Decoy',
        'Touchstone',
        'Grasshopper',
        'So iLL',
        'Woods',
      ]),
    );
    expect(PARTNER_APP_NAME_DENYLIST).toContain('Moon Climbing');
    expect(PARTNER_APP_NAME_DENYLIST).not.toContain('Spray wall');
  });

  it.each([
    'Boardsesh',
    'boardsesh sync',
    'Board Sesh Trainer',
    'B0ardsesh',
    'Bоardsesh',
    'BOARDSÉSH',
    'b.o.a.r.d.s.e.s.h',
    'Kilter Planner',
    'K1lter Logbook',
    'KiIter Coach',
    'MoonBoard Pro',
    'Moon Board Pro',
    'Tension Tracker',
    'So iLL Training',
    'Aurora Sync',
    'VVoods Trainer',
    'Touchstone Climbing',
    'Grasshopper Logs',
    'Decoy Tools',
  ])('refuses %j', (name) => {
    expect(refusalMessage(() => validatePartnerAppName(name))).toMatch(/cannot use or imitate/);
  });

  it.each(['Sequence', 'DivePeaks', 'Hangboard Planner', 'Crimp Lab', 'Spray Wall Coach'])('allows %j', (name) => {
    expect(validatePartnerAppName(name)).toBe(name);
  });

  it('trims and collapses spacing, and refuses short, long, blank and control-character names', () => {
    expect(validatePartnerAppName('  Crimp   Lab ')).toBe('Crimp Lab');
    expect(refusalMessage(() => validatePartnerAppName('ab'))).toMatch(/3 to 50/);
    expect(refusalMessage(() => validatePartnerAppName('a'.repeat(51)))).toMatch(/3 to 50/);
    expect(refusalMessage(() => validatePartnerAppName('---'))).toMatch(/letter or number/);
    expect(refusalMessage(() => validatePartnerAppName('Crimp\u0007Lab'))).toMatch(/control characters/);
    expect(refusalMessage(() => validatePartnerAppName(undefined))).toMatch(/name/);
  });
});

describe('lookalike letters', () => {
  // Each of these once passed: the skeleton dropped the foreign letter, so the
  // denylist saw "lter labs" for "Κilter Labs".
  const lookalikes = [
    'Κilter Labs', // Greek capital kappa
    'Kılter Labs', // Latin dotless i
    'Tεnsion Ltd', // Greek epsilon
    'ʙoardsesh', // Latin small capital B
    'MօօnBoard', // Armenian oh
    'Auroгa Climbing', // Cyrillic ghe
    'Kɪlter', // Latin small capital I
    'ᴋilter', // Latin small capital K
    'Aurorɑ', // Latin alpha
  ];

  it.each(lookalikes)('refuses %j as an app name and as a publisher', (name) => {
    expect(refusalMessage(() => validatePartnerAppName(name))).toMatch(/cannot use or imitate|cannot mix Latin/);
    expect(refusalMessage(() => validatePartnerPublisherName(name))).toMatch(
      /publisher name (cannot use or imitate|cannot mix Latin)/,
    );
  });

  it.each(['Crimp Lаbs', 'Sеquence', 'Hangboard Ρlanner', 'Fingerboard ᏟLI', 'Planner Լabs'])(
    'refuses Latin mixed with Greek, Cyrillic, Armenian or Cherokee letters, brand or not: %j',
    (name) => {
      expect(refusalMessage(() => validatePartnerAppName(name))).toBe(
        'The app name cannot mix Latin letters with Greek, Cyrillic, Armenian or Cherokee ones.',
      );
    },
  );

  it.each(['Κρίμπ Λαμπ', 'Скалолазный дневник', 'Մագլցում', 'Ξενία Παπαδοπούλου', 'Crimp ラボ', 'Café Crimp 2'])(
    'allows a name written in one script, or Latin with a script that has no lookalikes: %j',
    (name) => {
      expect(validatePartnerAppName(name)).toBe(name);
      expect(validatePartnerPublisherName(name)).toBe(name);
    },
  );
});

describe('publisher names', () => {
  // The same list the app names are checked against: "Made by" sits right
  // under the app's name, so it cannot be the place to pass as Boardsesh.
  it.each([
    'Boardsesh',
    'Boardsesh Team',
    'The B0ardsesh Crew',
    'Bоardsesh Labs',
    'Aurora Climbing',
    'Moon Climbing',
    'MoonClimbing Ltd',
    'M00n Climbing',
    'Kilter Grips',
    'K1lter',
    'Tension Climbing',
    'So iLL Holds',
    'Decoy Holds',
    'Woods Holds',
  ])('refuses %j', (name) => {
    expect(refusalMessage(() => validatePartnerPublisherName(name))).toMatch(/publisher name cannot use or imitate/);
  });

  it.each(['Crimp Labs', 'Sequence Climbing Ltd', 'Ana Ruiz', 'DivePeaks', 'Moonlight Software'])(
    'allows %j',
    (name) => {
      expect(validatePartnerPublisherName(name)).toBe(name);
    },
  );

  it('applies the app-name length and character rules, worded for the publisher', () => {
    expect(validatePartnerPublisherName('  Crimp   Labs ')).toBe('Crimp Labs');
    expect(validatePartnerPublisherName('Ｃｒｉｍｐ Labs')).toBe('Crimp Labs');
    expect(refusalMessage(() => validatePartnerPublisherName('ab'))).toBe(
      'The publisher name must be 3 to 50 characters.',
    );
    expect(refusalMessage(() => validatePartnerPublisherName('a'.repeat(51)))).toMatch(/3 to 50/);
    expect(refusalMessage(() => validatePartnerPublisherName('...'))).toMatch(
      /publisher name needs at least one letter/,
    );
    expect(refusalMessage(() => validatePartnerPublisherName('Crimp\u202eLabs'))).toMatch(
      /publisher name cannot contain control characters/,
    );
    expect(refusalMessage(() => validatePartnerPublisherName(undefined))).toMatch(/who makes the app/);
    expect(refusalMessage(() => validatePartnerPublisherName(42))).toMatch(/who makes the app/);
  });
});

describe('consent screen links', () => {
  it('accepts https and writes the URL as the parser does', () => {
    expect(validatePartnerAppLink('https://Example.com/privacy', 'privacy policy URL')).toBe(
      'https://example.com/privacy',
    );
  });

  it.each([
    ['http://example.com/privacy', /https/],
    ['javascript:alert(1)', /https/],
    ['https://user:pass@example.com/', /user name or password/],
    ['https://www.boardsesh.com/privacy', /boardsesh\.com/],
    ['not a url', /not a valid URL/],
    ['', /1 to 2048/],
  ])('refuses %j', (url, reason) => {
    expect(refusalMessage(() => validatePartnerAppLink(url, 'privacy policy URL'))).toMatch(reason);
  });
});

describe('a registration request', () => {
  const TERMS = 'test-terms-2026-11-10';
  const normalize = (raw: Record<string, unknown>) => normalizePartnerAppInput(raw, TERMS);
  const valid = {
    name: 'Crimp Lab',
    publisherName: 'Crimp Labs',
    homepageUrl: 'https://crimp.example.com',
    privacyPolicyUrl: 'https://crimp.example.com/privacy',
    applicationType: 'native',
    tokenEndpointAuthMethod: 'none',
    redirectUris: ['com.example.crimp:/oauth/boardsesh'],
    acceptedTermsVersion: TERMS,
  };

  it('keeps only the fields the rules know', () => {
    expect(normalize({ ...valid, skip_consent: true, require_pkce: false, jwks_uri: 'x' })).toEqual({
      name: 'Crimp Lab',
      publisherName: 'Crimp Labs',
      homepageUrl: 'https://crimp.example.com/',
      privacyPolicyUrl: 'https://crimp.example.com/privacy',
      applicationType: 'native',
      tokenEndpointAuthMethod: 'none',
      redirectUris: ['com.example.crimp:/oauth/boardsesh'],
      acceptedTermsVersion: TERMS,
    });
  });

  it('takes the shared terms version, and a variable may name another only outside production', () => {
    const base = { PARTNER_OAUTH_SECRETS: `1:${'s'.repeat(40)}`, NEXTAUTH_SECRET: 'next-auth-secret' };
    const read = (environment: Record<string, string>, production: boolean) =>
      readPartnerAuthorityConfiguration(environment as unknown as NodeJS.ProcessEnv, { production })
        .developerTermsVersion;
    const named = { ...base, PARTNER_DEVELOPER_TERMS_VERSION: ' 2026-12-01 ' };
    expect(read(base, false)).toBe(PARTNER_DEVELOPER_TERMS_VERSION);
    expect(read(named, false)).toBe('2026-12-01');
    // Production: publishing terms is a code change, never an environment flip.
    expect(read(base, true)).toBe(PARTNER_DEVELOPER_TERMS_VERSION);
    expect(read(named, true)).toBe(PARTNER_DEVELOPER_TERMS_VERSION);
    // This test process is not production, which is how the suites publish their own version.
    expect(readPartnerAuthorityConfiguration(named as unknown as NodeJS.ProcessEnv).developerTermsVersion).toBe(
      '2026-12-01',
    );
  });

  it('refuses every registration while the terms are a draft, before any other check', () => {
    expect(isDraftDeveloperTermsVersion('2026-11-10-draft')).toBe(true);
    expect(isDraftDeveloperTermsVersion(TERMS)).toBe(false);
    for (const raw of [{ ...valid, acceptedTermsVersion: '2026-11-10-draft' }, { name: 'x' }]) {
      let refused: unknown;
      try {
        normalizePartnerAppInput(raw, '2026-11-10-draft');
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(PartnerRegistrationError);
      expect(refused).toMatchObject({ reason: 'terms_unpublished' });
      expect((refused as Error).message).toMatch(/^Developer terms are not published yet/);
    }
  });

  it.each([undefined, null, '', 'yes', true, '2026-01-01', ` ${TERMS}`])(
    'refuses a registration that did not accept the current developer terms (%j)',
    (acceptedTermsVersion) => {
      expect(refusalMessage(() => normalize({ ...valid, acceptedTermsVersion }))).toMatch(
        /Accept the current Boardsesh developer terms/,
      );
    },
  );

  it.each(['private_key_jwt', 'client_secret_jwt', 'tls_client_auth', 'self_signed_tls_client_auth', 'NONE', ''])(
    'refuses the token endpoint method %j',
    (tokenEndpointAuthMethod) => {
      expect(refusalMessage(() => normalize({ ...valid, tokenEndpointAuthMethod }))).toMatch(
        /none, client_secret_basic or client_secret_post/,
      );
    },
  );

  it('requires a publisher, under the same rules as the app name', () => {
    expect(refusalMessage(() => normalize({ ...valid, publisherName: undefined }))).toMatch(/who makes the app/);
    expect(refusalMessage(() => normalize({ ...valid, publisherName: '' }))).toMatch(/3 to 50/);
    expect(refusalMessage(() => normalize({ ...valid, publisherName: 'Aurora Labs' }))).toMatch(/imitate "Aurora"/);
  });

  it('lets an edit change the publisher but never clear it', () => {
    expect(normalizePartnerAppPatch({ publisherName: ' Crimp  Labs ' }, 'web')).toEqual({
      publisherName: 'Crimp Labs',
    });
    expect(refusalMessage(() => normalizePartnerAppPatch({ publisherName: 'Boardsesh' }, 'web'))).toMatch(
      /imitate "Boardsesh"/,
    );
    expect(refusalMessage(() => normalizePartnerAppPatch({ publisherName: '' }, 'web'))).toMatch(/3 to 50/);
    // Null and a missing field both mean "keep it", like the app name.
    expect(refusalMessage(() => normalizePartnerAppPatch({ publisherName: null }, 'web'))).toMatch(
      /at least one field/,
    );
  });

  it('refuses an unknown app type and a missing privacy policy', () => {
    expect(refusalMessage(() => normalize({ ...valid, applicationType: 'spa' }))).toMatch(/web or native/);
    expect(refusalMessage(() => normalize({ ...valid, privacyPolicyUrl: undefined }))).toMatch(/privacy policy URL/);
  });

  it('checks an edit against the stored app type', () => {
    expect(normalizePartnerAppPatch({ redirectUris: ['http://127.0.0.1/cb'] }, 'native')).toEqual({
      redirectUris: ['http://127.0.0.1/cb'],
    });
    expect(refusalMessage(() => normalizePartnerAppPatch({ redirectUris: ['http://127.0.0.1/cb'] }, 'web'))).toMatch(
      /web app can only use https/,
    );
    expect(normalizePartnerAppPatch({ homepageUrl: null }, 'web')).toEqual({ homepageUrl: null });
    expect(refusalMessage(() => normalizePartnerAppPatch({ name: null }, 'web'))).toMatch(/at least one field/);
  });
});

describe('PARTNER_OAUTH_DEVELOPER_ALLOWLIST', () => {
  it('reads comma-separated ids, and fails closed when unset', () => {
    expect([...parsePartnerDeveloperAllowlist(' user-1, user-2 ,,user-3')]).toEqual(['user-1', 'user-2', 'user-3']);
    expect(parsePartnerDeveloperAllowlist(undefined).size).toBe(0);
    expect(parsePartnerDeveloperAllowlist('').size).toBe(0);
    expect(parsePartnerDeveloperAllowlist('*').has('anyone')).toBe(false);
  });
});
