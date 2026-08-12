import { describe, it, expect } from 'vitest';
import { userIdFromJwt } from '../jwt-user-id';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwtWithPayload(payload: string): string {
  return `${base64Url('{"alg":"HS256","typ":"JWT"}')}.${base64Url(payload)}.c2lnbmF0dXJl`;
}

describe('userIdFromJwt', () => {
  it('reads the sub claim from a well-formed token', () => {
    const token = jwtWithPayload('{"sub":"3f0c8a2e-1b2c-4d5e-8f90-abcdef123456","iss":"boardsesh","exp":1893456000}');
    expect(userIdFromJwt(token)).toBe('3f0c8a2e-1b2c-4d5e-8f90-abcdef123456');
  });

  it('decodes payloads that use the base64url alphabet and drop padding', () => {
    // This payload's standard base64 contains both '+' and '/' and needs padding,
    // so the token exercises the -/_ substitution and the stripped '='.
    const token = jwtWithPayload('{"sub":"user-1","note":"~~~?>?"}');
    const payloadSegment = token.split('.')[1];
    expect(payloadSegment).toMatch(/[-_]/);
    expect(payloadSegment).not.toMatch(/[+/=]/);
    expect(userIdFromJwt(token)).toBe('user-1');
  });

  it('decodes multi-byte UTF-8 in the payload without mangling the sub', () => {
    const token = jwtWithPayload('{"name":"Márco 🧗","sub":"user-2"}');
    expect(userIdFromJwt(token)).toBe('user-2');
  });

  it('returns undefined for an absent token', () => {
    expect(userIdFromJwt(null)).toBeUndefined();
    expect(userIdFromJwt(undefined)).toBeUndefined();
    expect(userIdFromJwt('')).toBeUndefined();
  });

  it('returns undefined for the wrong number of segments', () => {
    expect(userIdFromJwt('header.payload')).toBeUndefined();
    expect(userIdFromJwt('a.b.c.d')).toBeUndefined();
    expect(userIdFromJwt('not-a-jwt')).toBeUndefined();
  });

  it('returns undefined when the payload is not JSON', () => {
    expect(userIdFromJwt(`${base64Url('{}')}.${base64Url('not json at all')}.sig`)).toBeUndefined();
    expect(userIdFromJwt(`${base64Url('{}')}.${base64Url('[1,2,3]')}.sig`)).toBeUndefined();
    expect(userIdFromJwt(`${base64Url('{}')}.${base64Url('null')}.sig`)).toBeUndefined();
  });

  it('returns undefined when sub is missing, empty, or not a string', () => {
    expect(userIdFromJwt(jwtWithPayload('{"iss":"boardsesh"}'))).toBeUndefined();
    expect(userIdFromJwt(jwtWithPayload('{"sub":""}'))).toBeUndefined();
    expect(userIdFromJwt(jwtWithPayload('{"sub":42}'))).toBeUndefined();
    expect(userIdFromJwt(jwtWithPayload('{"sub":null}'))).toBeUndefined();
  });

  it('never throws on hostile or truncated input', () => {
    const hostile = ['..', 'a..c', `${base64Url('{}')}..sig`, '💥.💥.💥', 'x.%%%%.y', 'a.b.'];
    for (const token of hostile) {
      expect(() => userIdFromJwt(token)).not.toThrow();
      expect(userIdFromJwt(token)).toBeUndefined();
    }
  });
});
