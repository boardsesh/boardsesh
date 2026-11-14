// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const fixture = vi.hoisted(() => ({ observe: vi.fn(), legacy: vi.fn() }));
vi.mock('../browser-consumers.server', () => ({ browserConsumerFacade: { observe: fixture.observe } }));
vi.mock('../credential-admission.server', async (original) => ({
  ...(await original<typeof import('../credential-admission.server')>()),
  admitPresentedWebCredential: fixture.legacy,
}));
import { withAuthResponseAdmission } from '../auth-response-admission.server';

const cursor = { bindingId: 'a'.repeat(64), version: 2, bindingExpiresAt: '2030-01-01T00:00:00.000Z' };
const anonymous = () => ({ status: 'anonymous' as const, cursor: { ...cursor } });
function request(action = 'signin/google', method = 'POST') {
  return new NextRequest(`https://www.example.test/api/auth/${action}`, { method });
}
function context(action = 'signin/google') {
  return { params: Promise.resolve({ nextauth: action.split('/') }) };
}
beforeEach(() => {
  fixture.observe.mockReset().mockResolvedValue(anonymous());
  fixture.legacy.mockReset().mockImplementation(() => {
    throw new Error('Unexpected legacy fallback');
  });
});
describe('strict source-free OAuth response admission', () => {
  it('completes only the anonymous callback after the exact primary cursor repeats', async () => {
    const standardActor = vi.fn();
    const sourceFree = vi.fn();
    const response = new Response(null, { status: 302 });
    const invoke = vi.fn(async () => response);
    expect(
      await withAuthResponseAdmission(request(), context(), invoke, standardActor, { cursor, complete: sourceFree }),
    ).toBe(response);
    expect(sourceFree).toHaveBeenCalledExactlyOnceWith(response);
    expect(standardActor).not.toHaveBeenCalled();
    expect(fixture.observe).toHaveBeenCalledTimes(2);
    expect(fixture.legacy).not.toHaveBeenCalled();
  });
  it('keeps anonymous OAuth blocked when no trusted source-free frame is supplied', async () => {
    const invoke = vi.fn();
    const result = await withAuthResponseAdmission(request(), context(), invoke);
    expect(result.status).toBe(503);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['bindingId', 'version', 'bindingExpiresAt'] as const)(
    'refuses a different %s before invoking the issuer',
    async (field) => {
      const changed = {
        ...cursor,
        [field]: field === 'version' ? 3 : field === 'bindingId' ? 'b'.repeat(64) : '2030-01-02T00:00:00.000Z',
      };
      const invoke = vi.fn();
      const complete = vi.fn();
      const result = await withAuthResponseAdmission(request(), context(), invoke, undefined, {
        cursor: changed as typeof cursor,
        complete,
      });
      expect(result.status).toBe(409);
      expect(invoke).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['session', 'GET'],
    ['signout', 'POST'],
    ['callback/credentials', 'GET'],
    ['callback/apple', 'POST'],
  ] as const)('does not grant this frame to %s %s', async (action, method) => {
    const invoke = vi.fn();
    const result = await withAuthResponseAdmission(request(action, method), context(action), invoke, undefined, {
      cursor,
      complete: vi.fn(),
    });
    expect(result.status).toBe(409);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['proof-required', 'missing-binding', 'denied', 'conflict', 'unavailable', 'legacy'] as const)(
    'never falls back from %s with a source-free frame',
    async (status) => {
      fixture.observe.mockResolvedValue({ status });
      const invoke = vi.fn();
      const complete = vi.fn();
      const result = await withAuthResponseAdmission(request(), context(), invoke, undefined, { cursor, complete });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(invoke).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(fixture.legacy).not.toHaveBeenCalled();
    },
  );
  it('rejects a later browser selection without completing either authority frame', async () => {
    const complete = vi.fn();
    const standard = vi.fn();
    const result = await withAuthResponseAdmission(
      request(),
      context(),
      async () => {
        fixture.observe.mockResolvedValue({ ...anonymous(), cursor: { ...cursor, version: 3 } });
        return new Response(null, { headers: { 'Set-Cookie': 'state=; Max-Age=0; Path=/' } });
      },
      standard,
      { cursor, complete },
    );
    expect(result.status).toBe(409);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(standard).not.toHaveBeenCalled();
  });
  it.each([
    '__Secure-next-auth.session-token',
    '__Host-boardsesh.browser-binding',
    '__Host-boardsesh.browser-proof.fake',
  ])('refuses an unquarantined %s write before anonymous completion', async (name) => {
    const complete = vi.fn();
    const result = await withAuthResponseAdmission(
      request(),
      context(),
      async () => new Response(null, { headers: { 'Set-Cookie': `${name}=unsafe; Path=/; Secure` } }),
      undefined,
      { cursor, complete },
    );
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
