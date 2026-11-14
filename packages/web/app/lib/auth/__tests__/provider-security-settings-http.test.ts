// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createProviderSecuritySettingsBroker, PROVIDER_SETTINGS_PATHS } from '../provider-security-settings.server';

const origin = 'https://www.boardsesh.test';
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: 'owned-provider-json-route-cookie-key-6975',
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
};
const operationKey = 'a'.repeat(64);
const actorContextKey = 'b'.repeat(64);
const observed = 'actual-selected-proof=opaque; operation-carrier=sealed; unrelated-analytics=retained';
const directUnlink = vi.fn<(input: unknown) => Promise<Response>>();
const directAck = vi.fn<(input: unknown) => Promise<Response>>();
const factory = vi.fn(() => ({ unlink: directUnlink, acknowledge: directAck }));
function broker() {
  return createProviderSecuritySettingsBroker({ environment, ready: () => true, directPublicationFactory: factory });
}
function request(
  operation: 'unlink' | 'acknowledge',
  options: {
    readonly headers?: HeadersInit;
    readonly body?: unknown;
    readonly url?: string;
    readonly signal?: AbortSignal;
  } = {},
) {
  const headers = new Headers({
    host: 'www.boardsesh.test',
    origin,
    'content-type': 'application/json',
    cookie: observed,
    'sec-fetch-site': 'same-origin',
  });
  new Headers(options.headers).forEach((content, name) => headers.set(name, content));
  return new Request(options.url ?? `http://0.0.0.0:3000${PROVIDER_SETTINGS_PATHS[operation]}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      options.body ?? (operation === 'unlink' ? { operationKey, actorContextKey } : { operationKey }),
    ),
    signal: options.signal,
  });
}
beforeEach(() => {
  factory.mockClear();
  directUnlink.mockReset();
  directAck.mockReset();
  directUnlink.mockImplementation(async () => Response.json({ outcome: 'completed' }));
  directAck.mockImplementation(async () => Response.json({ outcome: 'completed' }));
});
afterEach(() => vi.unstubAllEnvs());

describe('mounted provider Settings HTTP boundary', () => {
  it.each(['unlink', 'acknowledge'] as const)(
    'accepts canonical Host/Origin on internal URL for %s and preserves exact prebuilt response',
    async (operation) => {
      const expected = Response.json(
        { outcome: 'completed' },
        { headers: { 'Set-Cookie': 'prebuilt-proof=opaque; Secure; HttpOnly' } },
      );
      const publish = operation === 'unlink' ? directUnlink : directAck;
      publish.mockResolvedValue(expected);
      const incoming = request(operation);
      const result = await broker()[operation](incoming);
      expect(result).toBe(expected);
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        cookieHeader: observed,
        operationKey,
        ...(operation === 'unlink' ? { actorContextKey } : {}),
        signal: incoming.signal,
      });
    },
  );
  it.each(['unlink', 'acknowledge'] as const)(
    'rejects forged source/budget/readiness fields before %s publisher',
    async (operation) => {
      for (const extra of [{ actor: { credential: 'forged-source' } }, { ready: true }, { requestBytes: 262144 }]) {
        const result = await broker()[operation](
          request(operation, {
            body: { operationKey, ...(operation === 'unlink' ? { actorContextKey } : {}), ...extra },
          }),
        );
        expect(result.status).toBe(400);
        expect(result.headers.getSetCookie()).toEqual([]);
      }
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it.each(['unlink', 'acknowledge'] as const)(
    'refuses untrusted Host and Origin before %s dispatch',
    async (operation) => {
      const invalidHeaders: HeadersInit[] = [
        { host: 'attacker.invalid' },
        { host: 'www.boardsesh.test,attacker.invalid' },
        { origin: 'null' },
        { origin: 'https://attacker.invalid', 'x-forwarded-host': 'www.boardsesh.test' },
      ];
      for (const headers of invalidHeaders)
        expect((await broker()[operation](request(operation, { headers }))).status).toBe(403);
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it.each(['unlink', 'acknowledge'] as const)(
    'bounds JSON before %s dispatch and refuses an already aborted request',
    async (operation) => {
      expect((await broker()[operation](request(operation, { headers: { 'content-length': '65537' } }))).status).toBe(
        400,
      );
      const controller = new AbortController();
      controller.abort();
      expect((await broker()[operation](request(operation, { signal: controller.signal }))).status).toBe(400);
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it.each(['unlink', 'acknowledge'] as const)(
    'sanitizes unexpected %s publisher rejection without source/cookie fallback',
    async (operation) => {
      (operation === 'unlink' ? directUnlink : directAck).mockRejectedValue(
        new Error('owned-private-source-must-not-escape'),
      );
      const result = await broker()[operation](request(operation));
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ outcome: 'unavailable' });
      expect(result.headers.getSetCookie()).toEqual([]);
    },
  );
  for (const [name, load] of [
    ['methods', async () => (await import('../../../api/internal/auth/provider-security/methods/route')).GET],
    ['resume', async () => (await import('../../../api/internal/auth/provider-security/resume/route')).GET],
    ['intent', async () => (await import('../../../api/internal/auth/provider-security/intent/route')).POST],
    [
      'password',
      async () => (await import('../../../api/internal/auth/provider-security/reauthenticate-password/route')).POST,
    ],
    ['unlink', async () => (await import('../../../api/internal/auth/provider-security/unlink/route')).POST],
    ['acknowledge', async () => (await import('../../../api/internal/auth/provider-security/acknowledge/route')).POST],
  ] as const)
    it(`actual exported ${name} route stays dark despite staged environment and HTTP readiness claims`, async () => {
      vi.resetModules();
      for (const [key, content] of Object.entries(environment)) vi.stubEnv(key, content);
      const handler = await load();
      const result = await handler(
        new Request(`${origin}${PROVIDER_SETTINGS_PATHS[name]}`, {
          method: name === 'methods' || name === 'resume' ? 'GET' : 'POST',
          headers: { host: 'www.boardsesh.test', origin, 'x-auth-ready': 'true' },
        }),
      );
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ outcome: 'unavailable' });
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(factory).not.toHaveBeenCalled();
    });
});
