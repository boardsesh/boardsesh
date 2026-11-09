// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
const admission = vi.hoisted(() => vi.fn());
vi.mock('../credential-admission.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../credential-admission.server')>()),
  admitPresentedWebCredential: admission,
}));

import { withAuthResponseAdmission } from '../auth-response-admission.server';
import { CredentialAuthorityUnavailable } from '../credential-admission.server';

const secret = 'owned-response-public-codec-fixture-secret';
let credentialA: string;
let credentialB: string;

beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
  vi.stubEnv('VERCEL_ENV', 'production');
  admission.mockReset();
  credentialA = await encode({ secret, token: { sub: 'owner-a' } });
  credentialB = await encode({ secret, token: { sub: 'owner-b' } });
  admission.mockImplementation(async (credential: string) =>
    credential === credentialA ? 'owner-a' : credential === credentialB ? 'owner-b' : null,
  );
});
afterEach(() => vi.unstubAllEnvs());

function request(action: string, cookie?: string): NextRequest {
  return new NextRequest(`https://www.boardsesh.com/api/auth/${action}`, {
    headers: cookie ? { cookie } : {},
  });
}
function context(action: string) {
  return { params: Promise.resolve({ nextauth: action.split('/') }) };
}
function sessionResponse(credential: string): Response {
  const response = Response.json({ user: { id: 'owner-a' } });
  response.headers.append(
    'Set-Cookie',
    `__Secure-next-auth.session-token=${credential}; Domain=.boardsesh.com; Path=/; HttpOnly; Secure`,
  );
  response.headers.append('Set-Cookie', '__Secure-next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; Secure');
  return response;
}

describe('buffered auth response admission', () => {
  it('admits the actual fresh JWE despite its following host-only migration clear', async () => {
    const response = await withAuthResponseAdmission(
      request('callback/credentials'),
      context('callback/credentials'),
      async () => sessionResponse(credentialB),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(admission).toHaveBeenCalledWith(credentialB);
  });

  it('reassembles emitted numbered chunks using the public cookie codec', async () => {
    const split = Math.floor(credentialB.length / 2);
    const handlerResponse = new Response(null);
    handlerResponse.headers.append(
      'Set-Cookie',
      `next-auth.session-token.1=${credentialB.slice(split)}; HttpOnly; Path=/`,
    );
    handlerResponse.headers.append(
      'Set-Cookie',
      `next-auth.session-token.0=${credentialB.slice(0, split)}; HttpOnly; Path=/`,
    );
    const response = await withAuthResponseAdmission(
      request('callback/credentials'),
      context('callback/credentials'),
      async () => handlerResponse,
    );
    expect(response).toBe(handlerResponse);
    expect(admission).toHaveBeenCalledWith(credentialB);
  });

  it('allows genuine B login carrying a revoked A cookie', async () => {
    admission.mockImplementation(async (credential: string) => (credential === credentialB ? 'owner-b' : null));
    const response = await withAuthResponseAdmission(
      request('callback/credentials', `__Secure-next-auth.session-token=${credentialA}`),
      context('callback/credentials'),
      async () => sessionResponse(credentialB),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(admission).not.toHaveBeenCalledWith(credentialA);
  });

  it('suppresses every cookie when deletion commits during session renewal', async () => {
    const handler = vi.fn(async () => {
      admission.mockResolvedValue(null);
      const response = sessionResponse(credentialA);
      response.headers.append('Set-Cookie', 'flow-state=; Path=/; Max-Age=0');
      return response;
    });
    const response = await withAuthResponseAdmission(
      request('session', `__Secure-next-auth.session-token=${credentialA}`),
      context('session'),
      handler,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('suppresses sign-out clears when A becomes deleted inside the handler', async () => {
    const response = await withAuthResponseAdmission(
      request('signout', `__Secure-next-auth.session-token=${credentialA}`),
      context('signout'),
      async () => {
        admission.mockResolvedValue(null);
        return new Response(null, { headers: { 'Set-Cookie': '__Secure-next-auth.session-token=; Max-Age=0' } });
      },
    );
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('still clears the cookie on sign-out when the authority is unavailable', async () => {
    admission.mockRejectedValue(new CredentialAuthorityUnavailable());
    const response = await withAuthResponseAdmission(
      request('signout', `__Secure-next-auth.session-token=${credentialA}`),
      context('signout'),
      async () => new Response(null, { headers: { 'Set-Cookie': '__Secure-next-auth.session-token=; Max-Age=0' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it('withholds fresh callback JWE and every flow cookie on authority unavailability', async () => {
    admission.mockRejectedValue(new CredentialAuthorityUnavailable());
    const response = await withAuthResponseAdmission(
      request('callback/credentials'),
      context('callback/credentials'),
      async () => sessionResponse(credentialB),
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('does not run a session handler for a known-deleted incoming credential', async () => {
    admission.mockResolvedValue(null);
    const handler = vi.fn();
    const response = await withAuthResponseAdmission(
      request('session', `next-auth.session-token=${credentialA}`),
      context('session'),
      handler,
    );
    expect(await response.json()).toEqual({});
    expect(handler).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
