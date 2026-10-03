import { fileURLToPath } from 'node:url';
import type { ConfigContext } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createExpoConfig from '../../app.config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Android verified App Links', () => {
  it.each(['boardsesh.com', 'www.boardsesh.com'])('opens board shares on %s', (host) => {
    vi.stubEnv('TAILSCALE_HOSTS', '');
    vi.stubEnv('EAS_BUILD', '1');
    vi.stubEnv('BOARDSESH_WEB', '');
    const config = createExpoConfig({
      config: { name: 'Boardsesh', slug: 'boardsesh' },
      projectRoot: fileURLToPath(new URL('../..', import.meta.url)),
    } as ConfigContext);
    const intentFilters = config.android?.intentFilters ?? [];

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
});
