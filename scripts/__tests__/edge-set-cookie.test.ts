/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { describeSetCookie } from '../../packages/web/partner-oauth-e2e/edge';

/** The edge's Set-Cookie log keeps names and attributes, and must never keep a value (#7596, B7a). */
describe('describeSetCookie', () => {
  it('keeps the name and the attributes in order, and drops the value', () => {
    const described = describeSetCookie(
      '__Secure-next-auth.session-token=eyJsecretvalue; Domain=.boardsesh.test; Path=/; Secure; HttpOnly; SameSite=Lax',
    );
    expect(described).toEqual({
      name: '__Secure-next-auth.session-token',
      attributes: ['Domain=.boardsesh.test', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'],
      clears: false,
      valueDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(JSON.stringify(described)).not.toContain('eyJsecretvalue');
  });

  it('gives one digest per value: the same value twice matches, another value does not, a clear has none', () => {
    const first = describeSetCookie('s=token-one; Path=/').valueDigest;
    expect(describeSetCookie('s=token-one; Path=/; Secure').valueDigest).toBe(first);
    expect(describeSetCookie('s=token-two; Path=/').valueDigest).not.toBe(first);
    expect(describeSetCookie('s=; Max-Age=0').valueDigest).toBe('');
  });

  it('keeps a value that contains an equals sign out of the name', () => {
    expect(describeSetCookie('a=b=c; Path=/').name).toBe('a');
  });

  it('reads an empty value, a zero Max-Age and a past Expires as a clear', () => {
    expect(describeSetCookie('s=; Path=/').clears).toBe(true);
    expect(describeSetCookie('s=x; Max-Age=0; Path=/').clears).toBe(true);
    expect(describeSetCookie('s=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT').clears).toBe(true);
    expect(describeSetCookie('s=x; Max-Age=3600').clears).toBe(false);
    expect(describeSetCookie('s=x; Expires=Fri, 01 Jan 2100 00:00:00 GMT').clears).toBe(false);
  });
});
