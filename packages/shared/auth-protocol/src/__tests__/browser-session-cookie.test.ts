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
const secureMarker = '__Secure-boardsesh.viewer';
const plainMarker = 'boardsesh.viewer';
const none = { conflicted: [] };

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
  it.each(['login', 'bridged'] as const)('appends the base64url HMAC-SHA256 of "%s:<token>"', (kind) => {
    const expectedSignature = createHmac('sha256', secret).update(`${kind}:${loginToken}`).digest('base64url');
    expect(signBrowserSessionCookie(kind, loginToken, secret)).toBe(`${loginToken}.${expectedSignature}`);
    expect(expectedSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('signs the same token differently for each kind', () => {
    expect(signBrowserSessionCookie('login', loginToken, secret)).not.toBe(
      signBrowserSessionCookie('bridged', loginToken, secret),
    );
  });

  it('refuses a secret shorter than 32 bytes', () => {
    expect(() => signBrowserSessionCookie('login', loginToken, 'x'.repeat(31))).toThrow(
      'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
    );
    expect(() => signBrowserSessionCookie('login', loginToken, '')).toThrow('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
  });

  it.each([undefined, null, 42, Buffer.alloc(64)])(
    'refuses the non-string secret %j with the named error',
    (badSecret) => {
      const untypedSecret = badSecret as unknown as string;
      expect(() => signBrowserSessionCookie('login', loginToken, untypedSecret)).toThrow(
        'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
      );
      expect(() => readBrowserSessionCookies('', untypedSecret, true)).toThrow(
        'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
      );
      expect(() =>
        serializeBrowserSessionCookie({ kind: 'login', token: loginToken, secret: untypedSecret, secure: true }),
      ).toThrow('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
    },
  );

  it('measures the secret in UTF-8 bytes, not characters', () => {
    // 16 two-byte characters are 32 bytes.
    expect(() => signBrowserSessionCookie('login', loginToken, 'é'.repeat(16))).not.toThrow();
    expect(() => signBrowserSessionCookie('login', loginToken, 'é'.repeat(15))).toThrow(
      'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
    );
  });

  it.each(['', 'has space', 'has;semicolon', 'has=equals', 'has.dot', 'has,comma', 'x'.repeat(513), 'ünïcode'])(
    'refuses the token %j',
    (token) => {
      expect(() => signBrowserSessionCookie('login', token, secret)).toThrow('BROWSER_SESSION_COOKIE_TOKEN_INVALID');
    },
  );

  it('keeps the refused token and secret out of the error', () => {
    expect(() => signBrowserSessionCookie('login', 'bad token', 'short-secret-value')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('short-secret-value') }),
    );
    expect(() => signBrowserSessionCookie('login', 'bad token value', secret)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('bad token value') }),
    );
  });
});

describe('readBrowserSessionCookies', () => {
  const signedLogin = signBrowserSessionCookie('login', loginToken, secret);
  const signedBridged = signBrowserSessionCookie('bridged', bridgedToken, secret);

  it('returns both verified raw tokens', () => {
    const header = `other=1; ${secureLogin}=${signedLogin}; ${secureBridged}=${signedBridged}; last=2`;
    expect(readBrowserSessionCookies(header, secret, true)).toEqual({
      login: loginToken,
      bridged: bridgedToken,
      conflicted: [],
    });
  });

  it('reads the plain names outside a secure context', () => {
    const header = `${plainLogin}=${signedLogin}; ${plainBridged}=${signedBridged}`;
    expect(readBrowserSessionCookies(header, secret, false)).toEqual({
      login: loginToken,
      bridged: bridgedToken,
      conflicted: [],
    });
  });

  it("reads only the names for the caller's context", () => {
    expect(readBrowserSessionCookies(`${plainLogin}=${signedLogin}`, secret, true)).toEqual(none);
    expect(readBrowserSessionCookies(`${secureLogin}=${signedLogin}`, secret, false)).toEqual(none);
  });

  it.each([undefined, null, '', ';;', 'unrelated=1', `${secureLogin}`, `${secureLogin}=`])(
    'returns nothing for %j',
    (header) => {
      expect(readBrowserSessionCookies(header, secret, true)).toEqual(none);
    },
  );

  it('strips spaces and tabs around names and values', () => {
    expect(readBrowserSessionCookies(`a=1;${secureLogin}=${signedLogin};b=2`, secret, true)).toEqual({
      login: loginToken,
      conflicted: [],
    });
    expect(readBrowserSessionCookies(`a=1; \t${secureLogin}\t = \t${signedLogin} \t; b=2`, secret, true)).toEqual({
      login: loginToken,
      conflicted: [],
    });
  });

  // String.prototype.trim also strips these. A browser does not, so such a name
  // is a different cookie, one that need not have been set with Secure.
  it.each(['\x0b', '\x0c', '\r', '\n', ' ', '﻿'])('treats a name padded with %j as another cookie', (pad) => {
    expect(readBrowserSessionCookies(`${pad}${secureLogin}=${signedLogin}`, secret, true)).toEqual(none);
    expect(readBrowserSessionCookies(`${secureLogin}${pad}=${signedLogin}`, secret, true)).toEqual(none);
    expect(readBrowserSessionCookies(`${secureLogin}=${signedLogin}${pad}`, secret, true)).toEqual(none);
  });

  it('ignores a padded look-alike sent beside the real cookie', () => {
    const header = `\x0b${secureLogin}=${signBrowserSessionCookie('login', bridgedToken, secret)}; ${secureLogin}=${signedLogin}`;
    expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken, conflicted: [] });
  });

  it('does not match a name only by prefix, suffix or case', () => {
    const header = [
      `${secureLogin}x=${signedLogin}`,
      `x${secureLogin}=${signedLogin}`,
      `${secureLogin.toLowerCase()}=${signedLogin}`,
      `${secureLogin}.0=${signedLogin}`,
    ].join('; ');
    expect(readBrowserSessionCookies(header, secret, true)).toEqual(none);
  });

  describe('tampering', () => {
    const signature = signedLogin.slice(loginToken.length + 1);

    it('rejects a value signed with another secret', () => {
      const header = `${secureLogin}=${signBrowserSessionCookie('login', loginToken, otherSecret)}`;
      expect(readBrowserSessionCookies(header, secret, true)).toEqual(none);
    });

    it('rejects a token swapped under a valid signature', () => {
      expect(readBrowserSessionCookies(`${secureLogin}=${bridgedToken}.${signature}`, secret, true)).toEqual(none);
    });

    it('rejects a login value moved to the bridged name', () => {
      expect(readBrowserSessionCookies(`${secureBridged}=${signedLogin}`, secret, true)).toEqual(none);
      expect(readBrowserSessionCookies(`${plainBridged}=${signedLogin}`, secret, false)).toEqual(none);
    });

    it('rejects a bridged value moved to the login name', () => {
      expect(readBrowserSessionCookies(`${secureLogin}=${signedBridged}`, secret, true)).toEqual(none);
      expect(readBrowserSessionCookies(`${plainLogin}=${signedBridged}`, secret, false)).toEqual(none);
    });

    it('rejects every single-character change to the signature', () => {
      for (let index = 0; index < signature.length; index += 1) {
        const original = signature[index];
        const replacement = original === 'A' ? 'B' : 'A';
        const tampered = `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
        expect(readBrowserSessionCookies(`${secureLogin}=${loginToken}.${tampered}`, secret, true)).toEqual(none);
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
      expect(readBrowserSessionCookies(`${secureLogin}=${cookieValue}`, secret, true)).toEqual(none);
    });

    it('keeps a valid name when the other name is tampered', () => {
      const header = `${secureLogin}=${signedLogin}; ${secureBridged}=${bridgedToken}.${signature}`;
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken, conflicted: [] });
    });
  });

  describe('duplicate names', () => {
    const otherLoginToken = 'Qm7vT2kW9pLx4nRb8sYd1cFh6jEz3aGu';
    const signedOtherLogin = signBrowserSessionCookie('login', otherLoginToken, secret);

    it('accepts a name sent twice with the same value (Domain and host-only copies of one login)', () => {
      const header = `${secureLogin}=${signedLogin}; ${secureLogin}=${signedLogin}`;
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken, conflicted: [] });
    });

    it('reports a name sent with two different valid values as conflicted, whichever comes first', () => {
      expect(
        readBrowserSessionCookies(`${secureLogin}=${signedLogin}; ${secureLogin}=${signedOtherLogin}`, secret, true),
      ).toEqual({ conflicted: ['login'] });
      expect(
        readBrowserSessionCookies(`${secureLogin}=${signedOtherLogin}; ${secureLogin}=${signedLogin}`, secret, true),
      ).toEqual({ conflicted: ['login'] });
    });

    it('reports a conflict when one copy is valid and the other is tampered or empty', () => {
      const tampered = `${loginToken}.${'A'.repeat(43)}`;
      expect(
        readBrowserSessionCookies(`${secureLogin}=${signedLogin}; ${secureLogin}=${tampered}`, secret, true),
      ).toEqual({ conflicted: ['login'] });
      expect(readBrowserSessionCookies(`${secureLogin}=; ${secureLogin}=${signedLogin}`, secret, true)).toEqual({
        conflicted: ['login'],
      });
    });

    it('keeps a conflicted login visible beside a valid bridged cookie, so the caller cannot fall through to it', () => {
      const header = [
        `${secureLogin}=${signedLogin}`,
        `${secureLogin}=${signedOtherLogin}`,
        `${secureBridged}=${signedBridged}`,
        `${secureBridged}=${signedBridged}`,
      ].join('; ');
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ bridged: bridgedToken, conflicted: ['login'] });
    });

    it('reports both kinds when both conflict', () => {
      const header = [
        `${secureLogin}=${signedLogin}`,
        `${secureLogin}=${signedOtherLogin}`,
        `${secureBridged}=${signedBridged}`,
        `${secureBridged}=x`,
      ].join('; ');
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ conflicted: ['login', 'bridged'] });
    });

    it('does not report identical tampered copies as a conflict', () => {
      const tampered = `${loginToken}.${'A'.repeat(43)}`;
      expect(readBrowserSessionCookies(`${secureLogin}=${tampered}; ${secureLogin}=${tampered}`, secret, true)).toEqual(
        none,
      );
    });

    it('accepts three identical copies', () => {
      const header = [signedLogin, signedLogin, signedLogin].map((value) => `${secureLogin}=${value}`).join('; ');
      expect(readBrowserSessionCookies(header, secret, true)).toEqual({ login: loginToken, conflicted: [] });
    });
  });

  it('refuses a short secret instead of reading with it, even for an empty header', () => {
    expect(() => readBrowserSessionCookies(`${secureLogin}=${signedLogin}`, 'short', true)).toThrow(
      'BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT',
    );
    expect(() => readBrowserSessionCookies(null, 'short', true)).toThrow('BROWSER_SESSION_COOKIE_SECRET_TOO_SHORT');
  });

  it.each(['login', 'bridged'] as const)('round-trips a %s cookie through serialize', (kind) => {
    const setCookie = serializeBrowserSessionCookie({ kind, token: loginToken, secret, secure: true });
    const pair = setCookie.split(';', 1)[0];
    expect(readBrowserSessionCookies(pair, secret, true)).toEqual({ [kind]: loginToken, conflicted: [] });
  });
});

describe('serializeBrowserSessionCookie', () => {
  const signedLogin = signBrowserSessionCookie('login', loginToken, secret);
  const signedBridged = signBrowserSessionCookie('bridged', bridgedToken, secret);

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

  it('never writes a Domain cookie without Secure', () => {
    expect(() =>
      serializeBrowserSessionCookie({
        kind: 'login',
        token: loginToken,
        secret,
        domain: '.boardsesh.com',
        secure: false,
      }),
    ).toThrow('BROWSER_SESSION_COOKIE_DOMAIN_REQUIRES_SECURE');
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
  const clear = (name: string, domain: string | undefined, secure: boolean) =>
    `${name}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  // The viewer marker is written without HttpOnly, so its clears carry none either.
  const markerClear = (name: string, domain: string | undefined, secure: boolean) =>
    `${name}=; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
  const domain = '.boardsesh.com';

  it('clears both secure names and the marker in the Domain and host-only scopes in production', () => {
    expect(browserSessionCookieClears({ domain, secure: true, requestCookieNames: [] })).toEqual([
      clear(secureLogin, undefined, true),
      clear(secureLogin, domain, true),
      clear(secureBridged, undefined, true),
      clear(secureBridged, domain, true),
      markerClear(secureMarker, undefined, true),
      markerClear(secureMarker, domain, true),
    ]);
  });

  it('clears both secure names and the marker host-only on a preview', () => {
    expect(browserSessionCookieClears({ secure: true, requestCookieNames: [] })).toEqual([
      clear(secureLogin, undefined, true),
      clear(secureBridged, undefined, true),
      markerClear(secureMarker, undefined, true),
    ]);
  });

  it('clears a plain name the request carried, with Secure in a secure context', () => {
    expect(browserSessionCookieClears({ domain, secure: true, requestCookieNames: [plainBridged] })).toEqual([
      clear(secureLogin, undefined, true),
      clear(secureLogin, domain, true),
      clear(secureBridged, undefined, true),
      clear(secureBridged, domain, true),
      clear(plainBridged, undefined, true),
      clear(plainBridged, domain, true),
      markerClear(secureMarker, undefined, true),
      markerClear(secureMarker, domain, true),
    ]);
  });

  it('clears a plain name the request carried, without Secure on local http', () => {
    expect(
      browserSessionCookieClears({
        secure: false,
        requestCookieNames: ['other', plainLogin, plainBridged, plainMarker],
      }),
    ).toEqual([
      clear(secureLogin, undefined, true),
      clear(secureBridged, undefined, true),
      clear(plainLogin, undefined, false),
      clear(plainBridged, undefined, false),
      markerClear(secureMarker, undefined, true),
      markerClear(plainMarker, undefined, false),
    ]);
  });

  it('never emits a Domain clear without Secure', () => {
    expect(() => browserSessionCookieClears({ domain, secure: false, requestCookieNames: [] })).toThrow(
      'BROWSER_SESSION_COOKIE_DOMAIN_REQUIRES_SECURE',
    );
  });

  it('ignores names that only resemble a session cookie', () => {
    expect(
      browserSessionCookieClears({
        secure: false,
        requestCookieNames: [
          `${plainLogin}.0`,
          plainLogin.toUpperCase(),
          'next-auth.session-token',
          'boardsesh.viewer.0',
        ],
      }),
    ).toEqual([
      clear(secureLogin, undefined, true),
      clear(secureBridged, undefined, true),
      markerClear(secureMarker, undefined, true),
    ]);
  });

  it('emits each clear once when the request repeated a name', () => {
    expect(browserSessionCookieClears({ secure: false, requestCookieNames: [plainLogin, plainLogin] })).toEqual([
      clear(secureLogin, undefined, true),
      clear(secureBridged, undefined, true),
      clear(plainLogin, undefined, false),
      markerClear(secureMarker, undefined, true),
    ]);
  });

  it('refuses an injected domain', () => {
    expect(() =>
      browserSessionCookieClears({ domain: '.boardsesh.com\r\nX: y', secure: true, requestCookieNames: [] }),
    ).toThrow('BROWSER_SESSION_COOKIE_DOMAIN_INVALID');
  });
});
