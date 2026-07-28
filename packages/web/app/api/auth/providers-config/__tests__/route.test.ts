import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../route';

describe('GET /api/auth/providers-config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports every provider when all required credentials are present', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret');
    vi.stubEnv('APPLE_ID', 'apple-id');
    vi.stubEnv('APPLE_SECRET', 'apple-secret');
    vi.stubEnv('FACEBOOK_CLIENT_ID', 'facebook-id');
    vi.stubEnv('FACEBOOK_CLIENT_SECRET', 'facebook-secret');

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      google: true,
      apple: true,
      facebook: true,
    });
  });

  it('reports no providers when credentials are absent', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', undefined);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', undefined);
    vi.stubEnv('APPLE_ID', undefined);
    vi.stubEnv('APPLE_SECRET', undefined);
    vi.stubEnv('FACEBOOK_CLIENT_ID', undefined);
    vi.stubEnv('FACEBOOK_CLIENT_SECRET', undefined);

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      google: false,
      apple: false,
      facebook: false,
    });
  });

  it('reports only providers with both required credentials', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret');
    vi.stubEnv('APPLE_ID', 'apple-id');
    vi.stubEnv('APPLE_SECRET', '');
    vi.stubEnv('FACEBOOK_CLIENT_ID', 'facebook-id');
    vi.stubEnv('FACEBOOK_CLIENT_SECRET', 'facebook-secret');

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      google: true,
      apple: false,
      facebook: true,
    });
  });
});
