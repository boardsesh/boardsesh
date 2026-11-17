/// <reference types="node" />

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS,
  BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES,
  browserSessionCookieClears,
  browserSessionCookieName,
  readBrowserSessionCookies,
  serializeBrowserSessionCookie,
  signBrowserSessionCookie,
} from '../browser-session-cookie';

const secret = 'a-test-secret-that-is-at-least-32-bytes-long';
const otherSecret = 'another-test-secret-also-32-bytes-or-more!!';
const loginToken = 'Xr4kD9mQ2vLp8sTn6wYb3cFh7jKz1aEu';
const bridgedToken = 'Bg5nW2pR8tLq4vXm9sKd1cYh6jFz3aTe';
const secureLogin = '__Secure-boardsesh.session_token';
const secureBridged = '__Secure-boardsesh.bridged_session_token';
const plainLogin = 'boardsesh.session_token';
const plainBridged = 'boardsesh.bridged_session_token';

describe('cookie names', () => {
  it('uses the __Secure- prefix only in a secure context', () => {
    expect(browserSessionCookieName('login', true)).toBe(secureLogin);
    expect(browserSessionCookieName('bridged', true)).toBe(secureBridged);
    expect(browserSessionCookieName('login', false)).toBe(plainLogin);
    expect(browserSessionCookieName('bridged', false)).toBe(plainBridged);
  });

  it('keeps the 400-day Max-Age and the 32-byte secret floor', () => {
    expect(BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS).toBe(34_560_000);
    expect(BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
    expect(BROWSER_SESSION_COOKIE_MIN_SECRET_BYTES).toBe(32);
  });
});

describe('signBrowserSessionCookie', () => {
  it('appends the base64url HMAC-SHA256 of the token', () => {
    const expectedSignature = createHmac('sha256', secret).update(loginToken).digest('base64url');
    expect(signBrowserSessionCookie(loginToken, secret)).toBe(`${loginToken}.${expectedSignature}`);
    expect(expectedSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a secret shorter than 32 bytes', () => {
    expect(() => signBrowserSessionCookie(loginToken, 'x'.repeat(31))).toThrow(
      'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
    );
    expect(() => signBrowserSessionCookie(loginToken, '')).toThrow('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
  });

  it('measures the secret in UTF-8 bytes, not characters', () => {
    // 16 two-byte characters are 32 bytes.
    expect(() => signBrowserSessionCookie(loginToken, 'é'.repeat(16))).not.toThrow();
    expect(() => signBrowserSessionCookie(loginToken, 'é'.repeat(15))).toThrow(
      'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
    );
  });

  it.each(['', 'has space', 'has;semicolon', 'has=equals', 'has.dot', 'has,comma', 'x'.repeat(513), 'ünïcode'])(
    'refuses the token %j',
    (token) => {
      expect(() => signBrowserSessionCookie(token, secret)).toThrow('BROWSER_SESSION_COOKIE_TOKEN_INVALID');
    },
  );

  it('keeps the refused token and secret out of the error', () => {
    expect(() => signBrowserSessionCookie('bad token', 'short-secret-value')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('short-secret-value') }),
    );
    expect(() => signBrowserSessionCookie('bad token value', secret)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('bad token value') }),
    );
  });
});

describe('readBrowserSessionCookies', () => {
  const signedLogin = signBrowserSessionCookie(loginToken, secret);
  const signedBridged = signBrowserSessionCookie(bridgedToken, secret);

  it('returns both verified raw tokens', () => {
    const header = `other=1; ${secureLogin}=${signedLogin}; ${secureBridged}=${signedBridged}; last=2`;
    expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken, bridged: bridgedToken });
  });

  it('reads the plain names outside a secure context', () => {
    const header = `${plainLogin}=${signedLogin}; ${plainBridged}=${signedBridged}`;
    expect(readBrowserSessionCookies(header, secret, false)).toEqual({ login: loginToken, bridged: bridgedToken });
  });

  it("reads only the names for the caller's context", () => {
    expect(readBrowserSessionCookies(`${plainLogin}=${signedLogin}`, secret, true)).toEqual({});
    expect(readBrowserSessionCookies(`${secureLogin}=${signedLogin}`, secret, false)).toEqual({});
  });

  it.each([undefined, null, '', ';;', 'unrelated=1', `${secureLogin}`, `${secureLogin}=`])(
    'returns nothing for %j',
    (header) => {
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({});
    },
  );

  it('tolerates missing and extra whitespace between pairs', () => {
    expect(readBrowserSessionCookies(`a=1;${secureLogin}=${signedLogin};b=2`, secret, true)).toEqual({
      login: loginToken,
    });
    expect(readBrowserSessionCookies(`a=1;   ${secureLogin}=${signedLogin}  ; b=2`, secret, true)).toEqual({
      login: loginToken,
    });
  });

  it('does not match a name only by prefix, suffix or case', () => {
    const header = [
      `${secureLogin}x=${signedLogin}`,
      `x${secureLogin}=${signedLogin}`,
      `${secureLogin.toLowerCase()}=${signedLogin}`,
      `${secureLogin}.0=${signedLogin}`,
    ].join('; ');
    expect(readBrowserSessionCookies(header, secret, true)).toEqual({});
  });

  describe('tampering', () => {
    const signature = signedLogin.slice(loginToken.length + 1);

    it('rejects a value signed with another secret', () => {
      const header = `${secureLogin}=${signBrowserSessionCookie(loginToken, otherSecret)}`;
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({});
    });

    it('rejects a token swapped under a valid signature', () => {
      expect(readBrowserSessionCookies(`${secureLogin}=${bridgedToken}.${signature}`, secret, true)).toEqual({});
    });

    it('rejects every single-character change to the signature', () => {
      for (let index = 0; index < signature.length; index += 1) {
        const original = signature[index];
        const replacement = original === 'A' ? 'B' : 'A';
        const tampered = `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
        expect(readBrowserSessionCookies(`${secureLogin}=${loginToken}.${tampered}`, secret, true)).toEqual({});
      }
    });

    it.each([
      ['no signature', loginToken],
      ['empty signature', `${loginToken}.`],
      ['empty token', `.${signature}`],
      ['padded signature', `${loginToken}.${signature}=`],
      ['standard base64 signature', `${loginToken}.${signature.replaceAll('-', '+').replaceAll('_', '/')}+/`],
      ['truncated signature', `${loginToken}.${signature.slice(0, -1)}`],
      ['extended signature', `${loginToken}.${signature}A`],
      ['two dots', `${loginToken}.${signature}.${signature}`],
      ['quoted value', `"${signedLogin}"`],
      ['percent-encoded dot', `${loginToken}%2E${signature}`],
      ['oversized token', `${'x'.repeat(513)}.${signature}`],
    ])('treats a value with %s as absent', (_label, cookieValue) => {
      expect(readBrowserSessionCookies(`${secureLogin}=${cookieValue}`, secret, true)).toEqual({});
    });

    it('keeps a valid name when the other name is tampered', () => {
      const header = `${secureLogin}=${signedLogin}; ${secureBridged}=${bridgedToken}.${signature}`;
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken });
    });
  });

  describe('duplicate names', () => {
    const otherLoginToken = 'Qm7vT2kW9pLx4nRb8sYd1cFh6jEz3aGu';
    const signedOtherLogin = signBrowserSessionCookie(otherLoginToken, secret);

    it('accepts a name sent twice with the same value (Domain and host-only copies of one login)', () => {
      const header = `${secureLogin}=${signedLogin}; ${secureLogin}=${signedLogin}`;
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken });
    });

    it('treats a name sent with two different valid values as absent, whichever comes first', () => {
      expect(
        readBrowserSessionCookies(`${secureLogin}=${signedLogin}; ${secureLogin}=${signedOtherLogin}`, secret, true),
      ).toEqual({});
      expect(
        readBrowserSessionCookies(`${secureLogin}=${signedOtherLogin}; ${secureLogin}=${signedLogin}`, secret, true),
      ).toEqual({});
    });

    it('treats a name as absent when one copy is valid and the other is tampered or empty', () => {
      const tampered = `${loginToken}.${'A'.repeat(43)}`;
      expect(
        readBrowserSessionCookies(`${secureLogin}=${signedLogin}; ${secureLogin}=${tampered}`, secret, true),
      ).toEqual({});
      expect(readBrowserSessionCookies(`${secureLogin}=; ${secureLogin}=${signedLogin}`, secret, true)).toEqual({});
    });

    it('rules on each name on its own', () => {
      const header = [
        `${secureLogin}=${signedLogin}`,
        `${secureLogin}=${signedOtherLogin}`,
        `${secureBridged}=${signedBridged}`,
        `${secureBridged}=${signedBridged}`,
      ].join('; ');
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ bridged: bridgedToken });
    });

    it('accepts three identical copies', () => {
      const header = [signedLogin, signedLogin, signedLogin].map((value) => `${secureLogin}=${value}`).join('; ');
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken });
    });
  });

  it('refuses a short secret instead of reading with it', () => {
    expect(() => readBrowserSessionCookies(`${secureLogin}=${signedLogin}`, 'short', true)).toThrow(
      'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
    );
  });

  it('round-trips through serialize', () => {
    const setCookie = serializeBrowserSessionCookie({ kind: 'login', token: loginToken, secret, secure: true });
    const pair = setCookie.split(';', 1)[0];
    expect(readBrowserSessionCookies(pair, secret, true)).toEqual({ login: loginToken });
  });
});

describe('serializeBrowserSessionCookie', () => {
  const signedLogin = signBrowserSessionCookie(loginToken, secret);
  const signedBridged = signBrowserSessionCookie(bridgedToken, secret);

  it('writes the production login cookie on the shared parent domain', () => {
    expect(
      serializeBrowserSessionCookie({
        kind: 'login',
        token: loginToken,
        secret,
        domain: '.boardsesh.com',
        secure: true,
      }),
    ).toBe(
      `${secureLogin}=${signedLogin}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it('writes the production bridged cookie under its own name', () => {
    expect(
      serializeBrowserSessionCookie({
        kind: 'bridged',
        token: bridgedToken,
        secret,
        domain: '.boardsesh.com',
        secure: true,
      }),
    ).toBe(
      `${secureBridged}=${signedBridged}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it('writes a host-only cookie on a preview', () => {
    expect(serializeBrowserSessionCookie({ kind: 'login', token: loginToken, secret, secure: true })).toBe(
      `${secureLogin}=${signedLogin}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it('writes a plain, host-only, non-Secure cookie on local http', () => {
    expect(serializeBrowserSessionCookie({ kind: 'login', token: loginToken, secret, secure: false })).toBe(
      `${plainLogin}=${signedLogin}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`,
    );
    expect(serializeBrowserSessionCookie({ kind: 'bridged', token: bridgedToken, secret, secure: false })).toBe(
      `${plainBridged}=${signedBridged}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`,
    );
  });

  it.each(['', 'boardsesh.com; Secure', 'evil.com\r\nSet-Cookie: x=1', 'board sesh.com', '.boardsesh.com;'])(
    'refuses the domain %j',
    (domain) => {
      expect(() =>
        serializeBrowserSessionCookie({ kind: 'login', token: loginToken, secret, domain, secure: true }),
      ).toThrow('BROWSER_SESSION_COOKIE_DOMAIN_INVALID');
    },
  );

  it('refuses a short secret and a bad token', () => {
    expect(() =>
      serializeBrowserSessionCookie({ kind: 'login', token: loginToken, secret: 'short', secure: true }),
    ).toThrow('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
    expect(() => serializeBrowserSessionCookie({ kind: 'login', token: 'a;b', secret, secure: true })).toThrow(
      'BROWSER_SESSION_COOKIE_TOKEN_INVALID',
    );
  });
});

describe('browserSessionCookieClears', () => {
  const clear = (name: string, domain?: string, secure = true) =>
    `${name}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  it('clears both secure names in the Domain and host-only scopes in production', () => {
    expect(browserSessionCookieClears('.boardsesh.com', [])).toEqual([
      clear(secureLogin),
      clear(secureLogin, '.boardsesh.com'),
      clear(secureBridged),
      clear(secureBridged, '.boardsesh.com'),
    ]);
  });

  it('clears both secure names host-only on a preview', () => {
    expect(browserSessionCookieClears(undefined, [])).toEqual([clear(secureLogin), clear(secureBridged)]);
  });

  it('also clears a plain name the request carried, without Secure so http accepts it', () => {
    expect(browserSessionCookieClears(undefined, ['other', plainLogin, plainBridged])).toEqual([
      clear(secureLogin),
      clear(secureBridged),
      clear(plainLogin, undefined, false),
      clear(plainBridged, undefined, false),
    ]);
    expect(browserSessionCookieClears('.boardsesh.com', [plainBridged])).toEqual([
      clear(secureLogin),
      clear(secureLogin, '.boardsesh.com'),
      clear(secureBridged),
      clear(secureBridged, '.boardsesh.com'),
      clear(plainBridged, undefined, false),
      clear(plainBridged, '.boardsesh.com', false),
    ]);
  });

  it('ignores names that only resemble a session cookie', () => {
    expect(
      browserSessionCookieClears(undefined, [`${plainLogin}.0`, plainLogin.toUpperCase(), 'next-auth.session-token']),
    ).toEqual([clear(secureLogin), clear(secureBridged)]);
  });

  it('emits each clear once when the request repeated a name', () => {
    expect(browserSessionCookieClears(undefined, [plainLogin, plainLogin])).toEqual([
      clear(secureLogin),
      clear(secureBridged),
      clear(plainLogin, undefined, false),
    ]);
  });

  it('refuses an injected domain', () => {
    expect(() => browserSessionCookieClears('.boardsesh.com\r\nX: y', [])).toThrow(
      'BROWSER_SESSION_COOKIE_DOMAIN_INVALID',
    );
  });
});
