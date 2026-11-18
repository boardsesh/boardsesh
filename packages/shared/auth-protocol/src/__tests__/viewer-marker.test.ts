/// <reference types="node" />

import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS,
  serializeBrowserSessionCookie,
  serializeViewerMarkerCookie,
  viewerMarkerValue,
} from '../browser-session-cookie';
import {
  computeViewerMarker,
  readViewerMarker,
  VIEWER_MARKER_DIGEST_PREFIX,
  viewerMarkerCookieName,
  viewerMarkerDigestInput,
} from '../viewer-marker';

/**
 * The value vector. The Expo web copy (`packages/mobile/src/lib/viewer-marker.web.ts`)
 * asserts the same pair, so all three implementations give one value.
 */
const VECTOR_SESSION_ID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const VECTOR_MARKER = '4mo7SstrZQClO7Ck';

const secret = 'a-test-secret-that-is-at-least-32-bytes-long';
const domain = '.boardsesh.com';

/** Attribute list of a `Set-Cookie` value, the name=value pair dropped. */
function attributesOf(setCookie: string): string[] {
  return setCookie.split('; ').slice(1);
}

function attribute(setCookie: string, name: string): string | undefined {
  return attributesOf(setCookie).find((candidate) => candidate.split('=')[0] === name);
}

describe('viewer marker value', () => {
  it('is the first 16 characters of base64url(sha256("boardsesh-viewer-v1:" + id))', () => {
    expect(VIEWER_MARKER_DIGEST_PREFIX).toBe('boardsesh-viewer-v1:');
    expect(viewerMarkerDigestInput(VECTOR_SESSION_ID)).toBe(`boardsesh-viewer-v1:${VECTOR_SESSION_ID}`);
    expect(viewerMarkerValue(VECTOR_SESSION_ID)).toBe(VECTOR_MARKER);
  });

  it('gives the same value on the server and through WebCrypto in a browser', async () => {
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    expect(await computeViewerMarker(VECTOR_SESSION_ID, subtle)).toBe(VECTOR_MARKER);
    for (const sessionId of ['x', 'session-with-üñíçødé', 'a'.repeat(200)]) {
      expect(await computeViewerMarker(sessionId, subtle)).toBe(viewerMarkerValue(sessionId));
    }
  });

  it('differs per login and never contains the id', () => {
    expect(viewerMarkerValue('session-one')).not.toBe(viewerMarkerValue('session-two'));
    expect(viewerMarkerValue(VECTOR_SESSION_ID)).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('has no value for an empty id, and no browser value without WebCrypto', async () => {
    expect(() => viewerMarkerValue('')).toThrow('VIEWER_MARKER_SESSION_ID_INVALID');
    expect(await computeViewerMarker('', webcrypto.subtle as unknown as SubtleCrypto)).toBeUndefined();
    expect(await computeViewerMarker(VECTOR_SESSION_ID, null)).toBeUndefined();
  });
});

describe('serializeViewerMarkerCookie', () => {
  it('uses the session cookie name rule', () => {
    expect(viewerMarkerCookieName(true)).toBe('__Secure-boardsesh.viewer');
    expect(viewerMarkerCookieName(false)).toBe('boardsesh.viewer');
  });

  it('writes the production marker readable by page scripts, with the session cookie’s scope', () => {
    const marker = serializeViewerMarkerCookie({ authSessionId: VECTOR_SESSION_ID, domain, secure: true });
    expect(marker).toBe(
      `__Secure-boardsesh.viewer=${VECTOR_MARKER}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; SameSite=Lax; Secure`,
    );
    expect(attributesOf(marker)).not.toContain('HttpOnly');
    const session = serializeBrowserSessionCookie({ kind: 'login', token: 'token', secret, domain, secure: true });
    for (const name of ['Path', 'Domain', 'Max-Age', 'SameSite', 'Secure'])
      expect(attribute(marker, name), name).toBe(attribute(session, name));
    expect(attribute(marker, 'Max-Age')).toBe(`Max-Age=${BROWSER_SESSION_COOKIE_MAX_AGE_SECONDS}`);
  });

  it('is host-only exactly when the session cookie is', () => {
    const marker = serializeViewerMarkerCookie({ authSessionId: VECTOR_SESSION_ID, secure: true });
    expect(attribute(marker, 'Domain')).toBeUndefined();
    expect(marker).toBe(`__Secure-boardsesh.viewer=${VECTOR_MARKER}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`);
  });

  it('writes the plain name without Secure on local http', () => {
    expect(serializeViewerMarkerCookie({ authSessionId: VECTOR_SESSION_ID, secure: false })).toBe(
      `boardsesh.viewer=${VECTOR_MARKER}; Path=/; Max-Age=34560000; SameSite=Lax`,
    );
  });

  it('refuses a Domain without Secure, an injected domain and an empty id', () => {
    expect(() => serializeViewerMarkerCookie({ authSessionId: VECTOR_SESSION_ID, domain, secure: false })).toThrow(
      'BROWSER_SESSION_COOKIE_DOMAIN_REQUIRES_SECURE',
    );
    expect(() =>
      serializeViewerMarkerCookie({ authSessionId: VECTOR_SESSION_ID, domain: '.a.com\r\nX: y', secure: true }),
    ).toThrow('BROWSER_SESSION_COOKIE_DOMAIN_INVALID');
    expect(() => serializeViewerMarkerCookie({ authSessionId: '', secure: true })).toThrow(
      'VIEWER_MARKER_SESSION_ID_INVALID',
    );
  });
});

describe('readViewerMarker', () => {
  it('reads the secure name in a secure context and the plain name on local http', () => {
    const cookie = `a=1; __Secure-boardsesh.viewer=${VECTOR_MARKER}; boardsesh.viewer=plainValue000000`;
    expect(readViewerMarker(cookie, true)).toEqual({ kind: 'present', value: VECTOR_MARKER });
    expect(readViewerMarker(cookie, false)).toEqual({ kind: 'present', value: 'plainValue000000' });
  });

  it('is missing when no copy is there, or only a name that resembles it', () => {
    expect(readViewerMarker('', true)).toEqual({ kind: 'missing' });
    expect(readViewerMarker('__Secure-boardsesh.viewer.0=x; boardsesh.viewer=y', true)).toEqual({ kind: 'missing' });
  });

  it('accepts identical copies and reports differing copies as conflicted', () => {
    expect(
      readViewerMarker(`__Secure-boardsesh.viewer=${VECTOR_MARKER}; __Secure-boardsesh.viewer=${VECTOR_MARKER}`, true),
    ).toEqual({ kind: 'present', value: VECTOR_MARKER });
    expect(
      readViewerMarker(`__Secure-boardsesh.viewer=${VECTOR_MARKER}; __Secure-boardsesh.viewer=other`, true),
    ).toEqual({
      kind: 'conflicted',
    });
  });
});
