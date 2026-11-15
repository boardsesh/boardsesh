// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const controls = vi.hoisted(() => ({ observe: vi.fn(), legacy: vi.fn() }));
vi.mock('../browser-consumers.server', () => ({ browserConsumerFacade: { observe: controls.observe } }));
vi.mock('../credential-admission.server', async (original) => ({
  ...(await original<typeof import('../credential-admission.server')>()),
  admitPresentedWebCredential: controls.legacy,
}));
import { withAuthResponseAdmission } from '../auth-response-admission.server';
const origin = 'https://www.password-admission.test',
  cursor = { bindingId: 'a'.repeat(64), version: 7, bindingExpiresAt: '2030-01-01T00:00:00.000Z' };
const scope = (complete = vi.fn()) => ({
  purpose: 'password-prepare' as const,
  canonicalOrigin: origin,
  cursor,
  complete,
});
const context = (action = 'callback/credentials') => ({ params: Promise.resolve({ nextauth: action.split('/') }) });
function request(path = 'callback/credentials', method = 'POST') {
  return new NextRequest(origin + '/api/auth/' + path, {
    method,
    headers: {
      host: new URL(origin).host,
      origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
  });
}
beforeEach(() => {
  controls.observe.mockReset().mockResolvedValue({ status: 'anonymous', cursor });
  controls.legacy.mockReset().mockImplementation(() => {
    throw new Error('Unexpected legacy fallback');
  });
});
describe('distinct anonymous password preparation response admission', () => {
  it('acknowledges only the exact quarantined response after repeated primary anonymous observation', async () => {
    const completion = vi.fn(),
      response = Response.json({ url: origin + '/settings' });
    expect(
      await withAuthResponseAdmission(
        request(),
        context(),
        async () => response,
        undefined,
        undefined,
        scope(completion),
      ),
    ).toBe(response);
    expect(completion).toHaveBeenCalledExactlyOnceWith(response);
    expect(controls.observe).toHaveBeenCalledTimes(2);
    expect(controls.legacy).not.toHaveBeenCalled();
  });
  it.each(['proof-required', 'missing-binding', 'denied', 'conflict', 'unavailable', 'legacy'] as const)(
    'never falls back from %s',
    async (status) => {
      controls.observe.mockResolvedValue({ status });
      const invoke = vi.fn();
      expect(
        (await withAuthResponseAdmission(request(), context(), invoke, undefined, undefined, scope())).status,
      ).toBeGreaterThanOrEqual(400);
      expect(invoke).not.toHaveBeenCalled();
      expect(controls.legacy).not.toHaveBeenCalled();
    },
  );
  it.each(['origin', 'host', 'path', 'method', 'content-type', 'cursor', 'mixed-scope'] as const)(
    'refuses wrong %s before framework invocation',
    async (fault) => {
      const current = request(
        fault === 'path' ? 'callback/google' : 'callback/credentials',
        fault === 'method' ? 'GET' : 'POST',
      );
      if (fault === 'origin') current.headers.set('origin', 'https://evil.test');
      if (fault === 'host') current.headers.set('host', 'evil.test');
      if (fault === 'content-type') current.headers.set('content-type', 'application/json');
      const frame = scope();
      if (fault === 'cursor') frame.cursor = { ...cursor, version: 6 };
      const invoke = vi.fn();
      const response = await withAuthResponseAdmission(
        current,
        context(),
        invoke,
        undefined,
        fault === 'mixed-scope' ? { cursor, complete: vi.fn() } : undefined,
        frame,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(invoke).not.toHaveBeenCalled();
    },
  );
  it('rejects cursor drift or protected proof writes before completion', async () => {
    const complete = vi.fn();
    const response = await withAuthResponseAdmission(
      request(),
      context(),
      async () => {
        controls.observe.mockResolvedValue({ status: 'anonymous', cursor: { ...cursor, version: 8 } });
        return Response.json({ url: origin + '/settings' });
      },
      undefined,
      undefined,
      scope(complete),
    );
    expect(response.status).toBe(409);
    expect(complete).not.toHaveBeenCalled();
    controls.observe.mockResolvedValue({ status: 'anonymous', cursor });
    const protectedReply = await withAuthResponseAdmission(
      request(),
      context(),
      async () =>
        Response.json(
          { url: origin + '/settings' },
          { headers: { 'Set-Cookie': '__Host-boardsesh.browser-proof.any=unsafe; Secure; Path=/' } },
        ),
      undefined,
      undefined,
      scope(complete),
    );
    expect(protectedReply.status).toBe(503);
    expect(complete).not.toHaveBeenCalled();
  });
});
