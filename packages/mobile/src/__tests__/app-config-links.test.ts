import { fileURLToPath } from 'node:url';
import type { ConfigContext } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createExpoConfig from '../../app.config';

afterEach(() => {
  vi.unstubAllEnvs();
});

function resolveIntentFilters() {
  vi.stubEnv('TAILSCALE_HOSTS', '');
  vi.stubEnv('EAS_BUILD', '1');
  vi.stubEnv('BOARDSESH_WEB', '');
  const config = createExpoConfig({
    config: { name: 'Boardsesh', slug: 'boardsesh' },
    projectRoot: fileURLToPath(new URL('../..', import.meta.url)),
  } as ConfigContext);
  return config.android?.intentFilters ?? [];
}

describe('Android verified App Links', () => {
  it('opens board shares on www.boardsesh.com', () => {
    const host = 'www.boardsesh.com';
    const intentFilters = resolveIntentFilters();

    // Cover the manifest entry that previously sent shared walls to the website.
    // Keep the existing join, preview and password-reset links verified too.
    for (const pathPrefix of ['/b/', '/join', '/preview', '/auth/reset-password']) {
      expect(intentFilters).toContainEqual(
        expect.objectContaining({
          action: 'VIEW',
          autoVerify: true,
          category: expect.arrayContaining(['BROWSABLE', 'DEFAULT']),
          data: expect.arrayContaining([{ scheme: 'https', host, pathPrefix }]),
        }),
      );
    }
  });

  it('leaves the apex host to the browser', () => {
    // boardsesh.com answers /.well-known/assetlinks.json with a redirect to www,
    // which Google's verifier rejects. On Android 11 and older one unverified
    // host stops every host in the app from verifying, so the apex must stay
    // out of the manifest. The classic board prefixes and their parity with
    // SUPPORTED_BOARDS are covered in scripts/mobile-ci-env-parity.test.ts.
    const hosts = resolveIntentFilters().flatMap((filter) =>
      (Array.isArray(filter.data) ? filter.data : [filter.data]).map((entry) => entry?.host),
    );
    expect(hosts).not.toContain('boardsesh.com');
    expect(new Set(hosts)).toEqual(new Set(['www.boardsesh.com']));
  });
});
