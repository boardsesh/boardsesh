import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { PROTOTYPE_ISSUER } from '../oauth-options';

type PrototypeEnvironment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
let environment: PrototypeEnvironment;

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.boardsesh.test', ...headers },
    body: JSON.stringify(body),
  });
}

describe('production origin and CSRF policy under the test runtime', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
  });
  afterAll(async () => environment?.close());

  for (const configuration of ['default', 'shared-domain override'] as const) {
    describe(configuration, () => {
      function authority() {
        return configuration === 'default'
          ? environment.auth
          : environment.createAuthority({
              advanced: { crossSubDomainCookies: { enabled: true, domain: '.boardsesh.test' } },
            });
      }

      it('rejects hostile cookie-authenticated signout without ending the valid session', async () => {
        const auth = authority();
        const registration = await auth.handler(
          request('/sign-up/email', {
            name: 'Origin fixture',
            email: `${randomUUID()}@example.test`,
            password: 'synthetic-origin-password',
          }),
        );
        expect(registration.status).toBe(200);
        const sessionCookie = registration.headers
          .getSetCookie()
          .find((cookie) => cookie.includes('better-auth.session_token='))
          ?.split(';')[0];
        expect(sessionCookie).toBeDefined();
        const hostile = await auth.handler(
          request('/sign-out', {}, { origin: 'https://untrusted.boardsesh.test', cookie: sessionCookie! }),
        );
        expect(hostile.status).toBe(403);
        expect(await hostile.json()).toMatchObject({ code: 'INVALID_ORIGIN' });
        expect(await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie! }) })).not.toBeNull();
        expect((await auth.handler(request('/sign-out', {}, { cookie: sessionCookie! }))).status).toBe(200);
        expect(await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie! }) })).toBeNull();
      });

      it('rejects untrusted callback destinations before creating an account', async () => {
        const auth = authority();
        const email = `${randomUUID()}@example.test`;
        const registration = { name: 'Callback fixture', email, password: 'synthetic-callback-password' };
        const hostile = await auth.handler(
          request('/sign-up/email', { ...registration, callbackURL: 'https://attacker.example/callback' }),
        );
        expect(hostile.status).toBe(403);
        expect(await hostile.json()).toMatchObject({ code: 'INVALID_CALLBACK_URL' });
        // The same address remains available: rejection performed no signup.
        expect((await auth.handler(request('/sign-up/email', registration))).status).toBe(200);
      });

      it('blocks first-login cross-site navigation even with a trusted Origin header', async () => {
        const auth = authority();
        const email = `${randomUUID()}@example.test`;
        const password = 'synthetic-navigation-password';
        await auth.api.signUpEmail({ body: { name: 'Navigation fixture', email, password } });
        const hostile = await auth.handler(
          request(
            '/sign-in/email',
            { email, password },
            { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
          ),
        );
        expect(hostile.status).toBe(403);
        expect(await hostile.json()).toMatchObject({ code: 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED' });
        expect(hostile.headers.getSetCookie()).toEqual([]);
        expect((await auth.handler(request('/sign-in/email', { email, password }))).status).toBe(200);
      });
    });
  }
});
