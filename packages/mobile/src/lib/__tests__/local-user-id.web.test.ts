// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

type WebAuthIdentity = { userId: string; authSessionId: string };

const { captureConfirmedWebAuthIdentity, getAuthToken } = vi.hoisted(() => ({
  captureConfirmedWebAuthIdentity: vi.fn<() => WebAuthIdentity | null>(),
  getAuthToken: vi.fn<() => Promise<string | null>>(),
}));

// Mocked as a factory so the real module — BroadcastChannel, crypto, and its
// module-level session state — never loads in this test.
vi.mock('../auth-store.web', () => ({ captureConfirmedWebAuthIdentity, getAuthToken }));

import { readLocalUserId } from '../local-user-id.web';

describe('readLocalUserId (web)', () => {
  beforeEach(() => {
    captureConfirmedWebAuthIdentity.mockReset();
    getAuthToken.mockReset();
  });

  it('reads the id off the identity the session confirmed', async () => {
    captureConfirmedWebAuthIdentity.mockReturnValue({ userId: 'user-42', authSessionId: 'session-1' });
    await expect(readLocalUserId()).resolves.toBe('user-42');
  });

  it('answers undefined while no identity is confirmed', async () => {
    captureConfirmedWebAuthIdentity.mockReturnValue(null);
    await expect(readLocalUserId()).resolves.toBeUndefined();
  });

  it('never consults the token, whose claims are encrypted (#4321)', async () => {
    captureConfirmedWebAuthIdentity.mockReturnValue({ userId: 'user-7', authSessionId: 'session-2' });
    getAuthToken.mockResolvedValue('header.encryptedkey.iv.ciphertext.tag');
    await expect(readLocalUserId()).resolves.toBe('user-7');
    expect(getAuthToken).not.toHaveBeenCalled();
  });
});
