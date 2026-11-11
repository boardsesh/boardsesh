import { describe, expect, it } from 'vite-plus/test';
import { NATIVE_V1_PATHS } from '@boardsesh/auth-protocol/native-v1';
import { recordings } from './recordings';
import { callRecorded, createReleasedClient } from './released-client';

const expiration = '2099-01-01T00:00:00.000Z';
for (const release of recordings.releases) {
  describe(`frozen refusal/transport/recovery behavior: ${release.tag}`, () => {
    for (const status of [400, 401, 403, 429, 500, 503, 'transport'] as const) {
      it(`reactive refresh ${status} preserves the recorded cleanup boundary`, async () => {
        let forcedSignOuts = 0;
        const paths: string[] = [];
        const client = await createReleasedClient(release, {
          fetch: async (input) => {
            const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
            paths.push(path);
            if (path === '/protected') return new Response('{}', { status: 401 });
            if (path === '/auth/native/revoke') return new Response('{}');
            if (path !== '/auth/native/refresh') throw new Error(`Unexpected frozen request ${path}`);
            if (status === 'transport') throw new TypeError('Synthetic transport unavailable');
            return Response.json({ error: 'Synthetic refusal' }, { status });
          },
        });
        await callRecorded(client.store, 'storeTokens', 'fixture-access', 'fixture-refresh', expiration);
        await callRecorded(client.interceptor, 'setOnForcedSignOut', () => {
          forcedSignOuts += 1;
        });
        const response = (await callRecorded(
          client.interceptor,
          'authenticatedFetch',
          'https://fixture.test/protected',
        )) as Response;
        expect(response.status).toBe(401);
        const expectedLogout = release.version.startsWith('2.2.') || status === 401 || status === 403;
        expect(forcedSignOuts).toBe(Number(expectedLogout));
        expect(await callRecorded(client.store, 'getAuthToken')).toBe(expectedLogout ? null : 'fixture-access');
        expect(await callRecorded(client.store, 'getRefreshToken')).toBe(expectedLogout ? null : 'fixture-refresh');
        expect(paths.filter((path) => path === '/auth/native/revoke')).toHaveLength(Number(expectedLogout));
        expect(paths.filter((path) => path === '/auth/native/refresh')).toHaveLength(1);
        if (expectedLogout) expect(paths.at(-1)).toBe(NATIVE_V1_PATHS.revoke);
      });
    }
    it('a transient keychain read failure leaves credentials available after recovery', async () => {
      let readUnavailable = false;
      const client = await createReleasedClient(release, {
        fetch: async () => {
          throw new Error('No network expected for keychain control');
        },
        secureReadFailure: () => readUnavailable,
      });
      await callRecorded(client.store, 'storeTokens', 'fixture-access', 'fixture-refresh', expiration);
      expect(await callRecorded(client.store, 'getAuthToken')).toBe('fixture-access');
      const writesBeforeFailure = client.nativeWrites.length;
      readUnavailable = true;
      await expect(callRecorded(client.store, 'getAuthToken')).rejects.toThrow('Synthetic keychain read unavailable');
      expect(client.nativeWrites).toHaveLength(writesBeforeFailure);
      readUnavailable = false;
      expect(await callRecorded(client.store, 'getAuthToken')).toBe('fixture-access');
      expect(await callRecorded(client.store, 'getRefreshToken')).toBe('fixture-refresh');
    });
    it('recovery calls retain paths, exact request fields and status failures', async () => {
      const requests: { path: string; body: unknown }[] = [];
      let status = 200;
      const client = await createReleasedClient(release, {
        fetch: async (input, init) => {
          if (typeof init?.body !== 'string') throw new Error('Recorded recovery body must be JSON text');
          requests.push({
            path: new URL(input instanceof Request ? input.url : input).pathname,
            body: JSON.parse(init.body) as unknown,
          });
          return Response.json({ error: 'Synthetic recovery refusal' }, { status });
        },
      });
      expect(await callRecorded(client.auth, 'requestPasswordReset', 'fixture@example.test')).toMatchObject({
        success: true,
      });
      expect(
        await callRecorded(
          client.auth,
          'resetPassword',
          'fixture@example.test',
          'opaque-link-token',
          'password-one',
          'password-two',
        ),
      ).toMatchObject({ success: true });
      expect(requests).toEqual([
        { path: '/api/auth/forgot-password', body: { email: 'fixture@example.test' } },
        {
          path: '/api/auth/reset-password',
          body: {
            email: 'fixture@example.test',
            token: 'opaque-link-token',
            password: 'password-one',
            confirmPassword: 'password-two',
          },
        },
      ]);
      // The source-executed client supplies these independent observed URLs;
      // the shared constants are never used to construct either request.
      expect(requests[0].path).toBe(NATIVE_V1_PATHS.forgotPassword);
      expect(requests[1].path).toBe(NATIVE_V1_PATHS.resetPassword);
      for (status of [400, 401, 403, 409, 429, 503]) {
        expect(await callRecorded(client.auth, 'requestPasswordReset', 'fixture@example.test')).toMatchObject({
          success: false,
          status,
          error: 'Synthetic recovery refusal',
        });
        expect(
          await callRecorded(
            client.auth,
            'resetPassword',
            'fixture@example.test',
            'opaque-link-token',
            'new-password',
            'new-password',
          ),
        ).toMatchObject({ success: false, status });
      }
    });
  });
}
