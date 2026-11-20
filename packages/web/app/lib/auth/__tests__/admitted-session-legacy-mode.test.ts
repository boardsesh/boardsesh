// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
  headers: async () => new Headers(),
}));
// With the mode unset, empty or `legacy`, the better-auth module is never even loaded.
vi.mock('../server-browser-session.server', () => {
  throw new Error('server-browser-session.server was imported in legacy mode');
});

import { getAdmittedRawServerToken, getAdmittedServerSession } from '../admitted-session.server';

afterEach(() => vi.unstubAllEnvs());

describe('server renders with the mode unset, empty or legacy (#7596 B4a)', () => {
  it.each([undefined, '', 'legacy'])('read only the legacy cookie and load nothing new (mode %j)', async (mode) => {
    if (mode !== undefined) vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    await expect(getAdmittedServerSession()).resolves.toBeNull();
    await expect(getAdmittedRawServerToken()).resolves.toBeUndefined();
    await expect(getAdmittedServerSession({ method: 'POST' })).resolves.toBeNull();
  });
});
