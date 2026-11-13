import { parseSync } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';
import { recordings, recordedSource } from './recordings';
import { callRecorded, createReleasedClient } from './released-client';

for (const release of recordings.releases) {
  describe(`recorded provider fallback hook: ${release.tag}`, () => {
    for (const provider of ['apple', 'google'] as const) {
      for (const status of [409, 503]) {
        it(`${provider} native ${status} keeps the frozen platform fallback`, async () => {
          const requests: string[] = [];
          const errors: (string | null)[] = [];
          const client = await createReleasedClient(release, {
            providerToken: async () => 'synthetic-provider-id-token',
            browserReturn: async () => 'com.boardsesh.app://auth/callback?transferToken=synthetic-opaque-transfer',
            fetch: async (input) => {
              const path = new URL(input instanceof Request ? input.url : input).pathname;
              requests.push(path);
              if (path === '/auth/native/oauth')
                return Response.json({ error: 'Synthetic native refusal' }, { status });
              if (path === '/auth/native/exchange')
                return Response.json({
                  jwt: 'fixture-access',
                  refreshToken: 'fixture-refresh',
                  expiresAt: '2099-01-01T00:00:00.000Z',
                });
              throw new Error(`Unrecorded fallback request ${path}`);
            },
          });
          const path = 'packages/mobile/src/hooks/use-native-oauth-sign-in.ts';
          const source = recordedSource(release, path);
          const parsed = parseSync(path, source);
          const declaration = parsed.program.body.find(
            (node) =>
              node.type === 'ExportNamedDeclaration' &&
              node.declaration?.type === 'FunctionDeclaration' &&
              node.declaration.id?.name === 'useNativeOAuthSignIn',
          );
          if (!declaration) throw new Error('Recorded OAuth hook declaration missing');
          const classifiers = await client.load('packages/mobile/src/lib/native-auth-analytics.ts');
          const hookModule = await client.evaluateFragment(source.slice(declaration.start, declaration.end), {
            ...classifiers,
            useCallback: (callback: unknown) => callback,
            useState: () => [false, () => {}],
            useRef: (initial: unknown) => ({ current: initial }),
            useEffect: (effect: () => void) => effect(),
            Platform: { OS: release.platform },
            useAuth: () => client.auth,
            useTranslation: () => ({ t: (key: string) => key }),
            useTrackLoginSucceeded: () => () => {},
            SHARED_EVENTS: new Proxy({}, { get: (_target, name) => String(name) }),
            loginProviderProperties: (selected: string) => ({ provider: selected, auth_method: selected }),
            track() {},
            reportError() {},
          });
          const hook = (await callRecorded(hookModule, 'useNativeOAuthSignIn', {
            setError: (message: string | null) => errors.push(message),
          })) as Record<string, unknown>;
          await callRecorded(hook, 'signIn', provider);
          const fallbackExpected = release.platform === 'ios';
          expect(client.effects.browserStarts).toBe(Number(fallbackExpected));
          expect(requests).toEqual(
            fallbackExpected ? ['/auth/native/oauth', '/auth/native/exchange'] : ['/auth/native/oauth'],
          );
          expect(await callRecorded(client.store, 'getAuthToken')).toBe(fallbackExpected ? 'fixture-access' : null);
          expect(errors.at(-1)).toBe(fallbackExpected ? null : 'nativeStart.oauthError');
        });
      }
    }
  });
}
