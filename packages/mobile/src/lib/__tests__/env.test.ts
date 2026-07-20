import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveClimbShareBaseUrl } from '../env';

// The exported constants are resolved at module load, so each env permutation
// needs a fresh module graph.
async function loadEnvModule() {
  vi.resetModules();
  return import('../env');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('resolveClimbShareBaseUrl', () => {
  it('falls back to the web origin when no app URL is configured', () => {
    expect(resolveClimbShareBaseUrl('', 'https://www.boardsesh.com')).toBe('https://www.boardsesh.com');
  });

  it('uses the app origin once one is configured', () => {
    expect(resolveClimbShareBaseUrl('https://app.boardsesh.com', 'https://www.boardsesh.com')).toBe(
      'https://app.boardsesh.com',
    );
  });
});

describe('CLIMB_SHARE_BASE_URL', () => {
  it('honours EXPO_PUBLIC_APP_URL so a staging build addresses its own export', async () => {
    vi.stubEnv('EXPO_PUBLIC_APP_URL', 'https://app.staging.boardsesh.com');
    const { CLIMB_SHARE_BASE_URL } = await loadEnvModule();
    expect(CLIMB_SHARE_BASE_URL).toBe('https://app.staging.boardsesh.com');
  });

  it('stays on the web origin while EXPO_PUBLIC_APP_URL is unset', async () => {
    vi.stubEnv('EXPO_PUBLIC_APP_URL', undefined);
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', undefined);
    const { CLIMB_SHARE_BASE_URL } = await loadEnvModule();
    expect(CLIMB_SHARE_BASE_URL).toBe('https://www.boardsesh.com');
  });

  it('follows the web origin override rather than the app default', async () => {
    vi.stubEnv('EXPO_PUBLIC_APP_URL', undefined);
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://staging.boardsesh.com');
    const { CLIMB_SHARE_BASE_URL } = await loadEnvModule();
    expect(CLIMB_SHARE_BASE_URL).toBe('https://staging.boardsesh.com');
  });

  it('moves to the app subdomain the moment EXPO_PUBLIC_APP_URL is set', async () => {
    vi.stubEnv('EXPO_PUBLIC_APP_URL', 'https://app.boardsesh.com');
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://www.boardsesh.com');
    const { CLIMB_SHARE_BASE_URL } = await loadEnvModule();
    expect(CLIMB_SHARE_BASE_URL).toBe('https://app.boardsesh.com');
  });
});
