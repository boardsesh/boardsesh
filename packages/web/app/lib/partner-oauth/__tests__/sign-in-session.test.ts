// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const controls = vi.hoisted(() => ({ resolution: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('@/app/lib/auth/server-browser-session.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/auth/server-browser-session.server')>()),
  serverBrowserSession: () => controls.resolution(),
}));

import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { readPartnerPageSession } from '../sign-in-session.server';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');

function active(overrides: { authenticatedAt?: string | null; linkGuarded?: boolean; unresolved?: boolean } = {}) {
  return {
    kind: 'active',
    accessToken: 'header.payload.signature',
    newerLegacyLoginUnresolved: overrides.unresolved ?? false,
    session: {
      userId: 'user-1',
      authSessionId: 'session-1',
      generation: 0,
      expiresAt: '2026-12-18T12:00:00.000Z',
      source: 'login',
      authenticatedAt: overrides.authenticatedAt === undefined ? '2026-11-18T11:58:00.000Z' : overrides.authenticatedAt,
      linkGuarded: overrides.linkGuarded ?? true,
      user: { id: 'user-1', email: 'climber@example.test', name: 'Climber', image: null },
    },
  };
}

beforeEach(() => {
  vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'better-auth');
  controls.resolution.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('readPartnerPageSession under better-auth (#7596 B4a)', () => {
  it('says what the session row says: account, a recent guarded sign-in and its time', async () => {
    controls.resolution.mockResolvedValue(active());
    await expect(readPartnerPageSession(NOW)).resolves.toEqual({
      account: 'climber@example.test',
      recentGuardedSignIn: true,
      signedInAtMs: Date.parse('2026-11-18T11:58:00.000Z'),
    });
  });

  it('is not a recent guarded sign-in without the link guard or with an unknown sign-in time', async () => {
    controls.resolution.mockResolvedValue(active({ linkGuarded: false }));
    await expect(readPartnerPageSession(NOW)).resolves.toMatchObject({ recentGuardedSignIn: false });
    controls.resolution.mockResolvedValue(active({ authenticatedAt: null }));
    await expect(readPartnerPageSession(NOW)).resolves.toMatchObject({
      recentGuardedSignIn: false,
      signedInAtMs: null,
    });
  });

  it('shows no account when signed out, and none beside a newer legacy login that was not bridged', async () => {
    controls.resolution.mockResolvedValue({ kind: 'signed-out' });
    await expect(readPartnerPageSession(NOW)).resolves.toBeNull();
    controls.resolution.mockResolvedValue(active({ unresolved: true }));
    await expect(readPartnerPageSession(NOW)).resolves.toBeNull();
  });

  it('reads the legacy cookie when the session read would, and fails on an outage instead of showing nobody', async () => {
    controls.resolution.mockResolvedValue({ kind: 'legacy' });
    // No legacy cookie on this request: the legacy reader finds nobody.
    await expect(readPartnerPageSession(NOW)).resolves.toBeNull();
    controls.resolution.mockRejectedValue(new CredentialAuthorityUnavailable());
    await expect(readPartnerPageSession(NOW)).rejects.toBeInstanceOf(CredentialAuthorityUnavailable);
  });
});
