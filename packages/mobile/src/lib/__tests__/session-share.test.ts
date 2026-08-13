import { afterEach, describe, expect, it, vi } from 'vitest';

// session-share reads WEB_BASE_URL at module load, so each env permutation needs
// a fresh module graph.
async function loadSessionShare() {
  vi.resetModules();
  return import('../session-share');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('buildSessionShareUrl', () => {
  it('builds the production join URL by default', async () => {
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', undefined);
    const { buildSessionShareUrl } = await loadSessionShare();
    expect(buildSessionShareUrl('session-123')).toBe('https://www.boardsesh.com/join/session-123');
  });

  // Regression: the join URL used to hardcode https://www.boardsesh.com, so a
  // staging or self-hosted build handed out invites into production.
  it('follows EXPO_PUBLIC_WEB_URL instead of hardcoding production', async () => {
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://staging.boardsesh.com');
    const { buildSessionShareUrl } = await loadSessionShare();
    expect(buildSessionShareUrl('session-123')).toBe('https://staging.boardsesh.com/join/session-123');
  });

  it('percent-encodes the session id', async () => {
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://www.boardsesh.com');
    const { buildSessionShareUrl } = await loadSessionShare();
    expect(buildSessionShareUrl('a b/c')).toBe('https://www.boardsesh.com/join/a%20b%2Fc');
  });
});
