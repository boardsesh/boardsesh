import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendLegacyHostOnlySessionCookieClear,
  appendSignOutSessionCookieClears,
  isSecureCookieContext,
  PLAIN_SESSION_COOKIE_NAME,
  responseSetsSessionCookie,
  SECURE_SESSION_COOKIE_NAME,
  sessionCookieDomain,
  sessionCookieName,
  sessionCookieNameCandidates,
} from '../secure-cookies';

// Pin every env the helpers read so values leaking in from the shell can't
// steer the branch under test.
function stubAuthEnv(
  overrides: Partial<Record<'AUTH_COOKIE_DOMAIN' | 'NEXTAUTH_URL' | 'VERCEL_ENV' | 'VERCEL_URL', string>>,
) {
  vi.stubEnv('AUTH_COOKIE_DOMAIN', overrides.AUTH_COOKIE_DOMAIN ?? '');
  vi.stubEnv('NEXTAUTH_URL', overrides.NEXTAUTH_URL ?? '');
  vi.stubEnv('VERCEL_ENV', overrides.VERCEL_ENV ?? '');
  vi.stubEnv('VERCEL_URL', overrides.VERCEL_URL ?? '');
}

// One row per environment this code has to survive, including the two the
// Railway cutover introduces. The point of the table is that a future edit
// which flips ANY of these rows fails here rather than in production, where
// flipping the cookie NAME logs out every signed-in user at once (#4651).
type CookieEnvCase = {
  label: string;
  env: Partial<Record<'AUTH_COOKIE_DOMAIN' | 'NEXTAUTH_URL' | 'VERCEL_ENV' | 'VERCEL_URL', string>>;
  secure: boolean;
  name: string;
  domain: string | undefined;
};

const COOKIE_ENV_CASES: CookieEnvCase[] = [
  {
    // As measured in production today: the tracked packages/web/.env.local ships
    // a loopback NEXTAUTH_URL, and the instrumentation hook rewrites it to the
    // canonical origin before any request is served.
    label: 'Vercel production, NEXTAUTH_URL already patched to the canonical origin',
    env: {
      VERCEL_ENV: 'production',
      VERCEL_URL: 'boardsesh-abc.vercel.app',
      NEXTAUTH_URL: 'https://www.boardsesh.com',
    },
    secure: true,
    name: SECURE_SESSION_COOKIE_NAME,
    domain: '.boardsesh.com',
  },
  {
    label: 'Vercel preview',
    env: { VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc.vercel.app' },
    secure: true,
    name: SECURE_SESSION_COOKIE_NAME,
    // A Domain=.boardsesh.com on a *.vercel.app response fails the browser's
    // domain-match check; preview login must stay host-only.
    domain: undefined,
  },
  {
    label: 'Railway production with the canonical https origin set, no VERCEL_* at all',
    env: { NEXTAUTH_URL: 'https://www.boardsesh.com' },
    secure: true,
    name: SECURE_SESSION_COOKIE_NAME,
    domain: '.boardsesh.com',
  },
  {
    // The bug #4651 is actually about: Dockerfile.web's runner stage carried no
    // canonical origin, so the container silently served plain-named, Domain-less
    // cookies. instrumentation.ts now refuses to boot here — this row pins what
    // the cookies WOULD be if it ever booted anyway.
    label: 'Railway production with no origin variable at all (pre-#4651 container)',
    env: {},
    secure: false,
    name: PLAIN_SESSION_COOKIE_NAME,
    domain: undefined,
  },
  {
    label: 'local dev over http',
    env: { VERCEL_ENV: 'development', NEXTAUTH_URL: 'http://localhost:3000' },
    secure: false,
    name: PLAIN_SESSION_COOKIE_NAME,
    domain: undefined,
  },
  {
    label: 'homelab preview host',
    env: { NEXTAUTH_URL: 'https://42.preview.boardsesh.com' },
    secure: true,
    name: SECURE_SESSION_COOKIE_NAME,
    domain: undefined,
  },
];

describe('session cookie shape across every host we run on', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(COOKIE_ENV_CASES)('$label', ({ env, secure, name, domain }) => {
    stubAuthEnv(env);
    expect(isSecureCookieContext()).toBe(secure);
    expect(sessionCookieName()).toBe(name);
    expect(sessionCookieDomain()).toBe(domain);
  });
});

describe('isSecureCookieContext', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is true in Vercel production', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(isSecureCookieContext()).toBe(true);
  });

  it('is true when NEXTAUTH_URL is https', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    expect(isSecureCookieContext()).toBe(true);
  });

  it('is false on http localhost with no Vercel context', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    expect(isSecureCookieContext()).toBe(false);
  });
});

describe('sessionCookieName', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the __Secure- prefix in a secure context', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(sessionCookieName()).toBe('__Secure-next-auth.session-token');
  });

  it('drops the prefix in a non-secure context', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    expect(sessionCookieName()).toBe('next-auth.session-token');
  });
});

describe('responseSetsSessionCookie', () => {
  beforeEach(() => vi.stubEnv('VERCEL_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it('is true when a fresh (non-empty) session cookie is written', () => {
    const response = new Response(null, {
      headers: {
        'Set-Cookie': '__Secure-next-auth.session-token=fresh-jwt; Path=/; Domain=.boardsesh.com; HttpOnly; Secure',
      },
    });
    expect(responseSetsSessionCookie(response)).toBe(true);
  });

  it('is false for the sign-out deletion (empty value)', () => {
    const response = new Response(null, {
      headers: {
        'Set-Cookie': '__Secure-next-auth.session-token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; Secure',
      },
    });
    expect(responseSetsSessionCookie(response)).toBe(false);
  });

  it('is false when no Set-Cookie header is present (a bare read)', () => {
    expect(responseSetsSessionCookie(new Response(null))).toBe(false);
  });

  it('is false when only an unrelated cookie is written', () => {
    const response = new Response(null, {
      headers: { 'Set-Cookie': 'other-cookie=value; Path=/' },
    });
    expect(responseSetsSessionCookie(response)).toBe(false);
  });

  it('finds the session cookie among multiple Set-Cookie headers', () => {
    const response = new Response(null);
    response.headers.append('Set-Cookie', 'csrf=abc; Path=/');
    response.headers.append('Set-Cookie', '__Secure-next-auth.session-token=fresh-jwt; Path=/; HttpOnly; Secure');
    expect(responseSetsSessionCookie(response)).toBe(true);
  });

  it('uses the non-prefixed name in a non-secure context', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    const response = new Response(null, {
      headers: { 'Set-Cookie': 'next-auth.session-token=fresh-jwt; Path=/; HttpOnly' },
    });
    expect(responseSetsSessionCookie(response)).toBe(true);
  });
});

describe('sessionCookieDomain', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('scopes to .boardsesh.com when serving the production www host', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com' });
    expect(sessionCookieDomain()).toBe('.boardsesh.com');
  });

  it('scopes to .boardsesh.com when serving the apex host', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://boardsesh.com' });
    expect(sessionCookieDomain()).toBe('.boardsesh.com');
  });

  it('honours an explicit AUTH_COOKIE_DOMAIN override', () => {
    stubAuthEnv({ AUTH_COOKIE_DOMAIN: '.staging.boardsesh.com', NEXTAUTH_URL: 'http://localhost:3000' });
    expect(sessionCookieDomain()).toBe('.staging.boardsesh.com');
  });

  it('is undefined on http localhost dev', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it('is undefined on a Vercel preview (VERCEL_URL set, not production, no NEXTAUTH_URL)', () => {
    // A `.boardsesh.com` Domain from a *.vercel.app response would be rejected
    // by the browser's domain-match check — preview login must stay host-only.
    stubAuthEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc123-marcodejonghs-projects.vercel.app' });
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it('is undefined on a homelab preview host, keeping the prod cookie identity untouchable', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://42.preview.boardsesh.com', VERCEL_ENV: '', VERCEL_URL: '' });
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it('falls back to .boardsesh.com in Vercel production when NEXTAUTH_URL is omitted', () => {
    stubAuthEnv({ VERCEL_ENV: 'production', VERCEL_URL: 'boardsesh.vercel.app' });
    expect(sessionCookieDomain()).toBe('.boardsesh.com');
  });

  it('is undefined when NEXTAUTH_URL is unparseable', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'not a url', VERCEL_ENV: 'preview' });
    expect(sessionCookieDomain()).toBeUndefined();
  });
});

describe('appendLegacyHostOnlySessionCookieClear', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('appends a Domain-less, Max-Age=0 deletion when the live cookie is Domain-scoped (prod)', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);

    const setCookies = response.headers.getSetCookie();
    const cleared = setCookies.find((cookie) => cookie.startsWith('__Secure-next-auth.session-token=;'));
    expect(cleared).toBeDefined();
    expect(cleared).not.toMatch(/;\s*Domain=/i);
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/Secure/);
  });

  it('is a no-op in dev, where the fresh cookie is itself host-only (same identity)', () => {
    // Appending the clear here would delete the login NextAuth just wrote:
    // cookie identity is name+domain+path, and with no cookie domain in play
    // the deletion targets the SAME cookie as the fresh write.
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('is a no-op on a Vercel preview even though the context is secure', () => {
    stubAuthEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc123-marcodejonghs-projects.vercel.app' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('sessionCookieNameCandidates', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('puts the secure name first in a secure context, and still offers the plain one', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com' });
    expect(sessionCookieNameCandidates()).toEqual([SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME]);
  });

  it('puts the plain name first in a non-secure context, and still offers the secure one', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    expect(sessionCookieNameCandidates()).toEqual([PLAIN_SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME]);
  });

  it('offers both names in every environment, so a wrong predicate cannot hide a live session', () => {
    // The whole point of the dual read: whatever the predicate decides, a reader
    // is handed both names. Narrow this to one and the #4651 failure mode — a
    // host change flips the name, every session becomes unreadable — comes back.
    for (const { env } of COOKIE_ENV_CASES) {
      stubAuthEnv(env);
      expect(new Set(sessionCookieNameCandidates())).toEqual(
        new Set([SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME]),
      );
    }
  });
});

describe('appendSignOutSessionCookieClears', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('clears both names in both scopes on the production www host', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendSignOutSessionCookieClears(response);

    const cleared = response.headers.getSetCookie();
    expect(cleared).toHaveLength(4);
    for (const name of [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME]) {
      const clearsForName = cleared.filter((setCookie) => setCookie.startsWith(`${name}=;`));
      expect(clearsForName, name).toHaveLength(2);
      expect(
        clearsForName.some((setCookie) => /;\s*Domain=\.boardsesh\.com/i.test(setCookie)),
        name,
      ).toBe(true);
      expect(
        clearsForName.some((setCookie) => !/;\s*Domain=/i.test(setCookie)),
        name,
      ).toBe(true);
      for (const setCookie of clearsForName) expect(setCookie, name).toMatch(/Max-Age=0/i);
    }
  });

  it('still clears both names where there is no cookie domain — the guard it must NOT inherit', () => {
    // appendLegacyHostOnlySessionCookieClear returns early when
    // sessionCookieDomain() is undefined, because on a LOGIN it would delete the
    // cookie NextAuth just wrote. A sign-out writes nothing, so inheriting that
    // early return would emit no clears at all on local dev, previews and a
    // mis-enved container — exactly where the dual read is most likely to be
    // resolving the other name, i.e. exactly where the logout bypass would bite.
    stubAuthEnv({ NEXTAUTH_URL: 'https://42.preview.boardsesh.com' });
    expect(sessionCookieDomain()).toBeUndefined();

    const response = new Response(null);
    appendSignOutSessionCookieClears(response);

    const cleared = response.headers.getSetCookie();
    expect(cleared).toHaveLength(2);
    expect(cleared.some((setCookie) => setCookie.startsWith(`${SECURE_SESSION_COOKIE_NAME}=;`))).toBe(true);
    expect(cleared.some((setCookie) => setCookie.startsWith(`${PLAIN_SESSION_COOKIE_NAME}=;`))).toBe(true);
    for (const setCookie of cleared) expect(setCookie).not.toMatch(/;\s*Domain=/i);
  });

  it('always marks the __Secure- clear Secure, and follows the context for the plain one', () => {
    // A `__Secure-` cookie is only accepted with the Secure attribute
    // (RFC 6265bis §4.1.3.1), so its deletion carries one even over http — where
    // the browser drops it, correctly, since no such cookie can exist there. A
    // Secure deletion of the PLAIN name over http would be dropped too, and that
    // one has a real cookie to delete.
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    const response = new Response(null);
    appendSignOutSessionCookieClears(response);

    const cleared = response.headers.getSetCookie();
    expect(cleared.find((setCookie) => setCookie.startsWith(`${SECURE_SESSION_COOKIE_NAME}=;`))).toMatch(/;\s*Secure/);
    expect(cleared.find((setCookie) => setCookie.startsWith(`${PLAIN_SESSION_COOKIE_NAME}=;`))).not.toMatch(
      /;\s*Secure/,
    );
  });

  it('clears the chunks of an oversized session cookie, not just the base name', () => {
    // next-auth splits a >4KB session into `<name>.0`, `<name>.1`, … and its
    // SessionStore reassembles anything whose name startsWith the base. Clear
    // only the base and a chunked session survives sign-out — and the fallback
    // read keeps honouring it. Drop the chunk loop and this goes red.
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com' });
    const response = new Response(null);
    appendSignOutSessionCookieClears(response, [
      `${PLAIN_SESSION_COOKIE_NAME}.0`,
      `${PLAIN_SESSION_COOKIE_NAME}.1`,
      'unrelated-cookie',
    ]);

    const clearedNames = response.headers.getSetCookie().map((setCookie) => setCookie.split('=', 1)[0]);
    expect(clearedNames).toContain(`${PLAIN_SESSION_COOKIE_NAME}.0`);
    expect(clearedNames).toContain(`${PLAIN_SESSION_COOKIE_NAME}.1`);
    // Never touch a cookie that isn't a session token.
    expect(clearedNames).not.toContain('unrelated-cookie');
  });

  it('clears every name the read path would accept, in every environment', () => {
    // Mutation guard: drop a name from appendSignOutSessionCookieClears and this
    // goes red. Without it, sign-out leaves a cookie the dual read still honours.
    for (const { env } of COOKIE_ENV_CASES) {
      stubAuthEnv(env);
      const response = new Response(null);
      appendSignOutSessionCookieClears(response);
      const clearedNames = new Set(response.headers.getSetCookie().map((setCookie) => setCookie.split('=', 1)[0]));
      for (const candidate of sessionCookieNameCandidates()) {
        expect([...clearedNames], JSON.stringify(env)).toContain(candidate);
      }
    }
  });
});
