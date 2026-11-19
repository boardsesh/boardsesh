import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// The profile cache feeds account emails into the device-token ledger (#7656).
const rememberEmailMock = vi.hoisted(() => vi.fn(async (_userId: string, _email: string) => {}));
vi.mock('../device-token-store', () => ({ rememberDeviceTokenAccountEmail: rememberEmailMock }));

import { profileAccountFromCache, watchProfileEmailForDeviceTokens } from '../device-token-profile-email';

beforeEach(() => {
  rememberEmailMock.mockClear();
});

describe('profileAccountFromCache', () => {
  it('reads the id and email of a signed-in profile', () => {
    expect(profileAccountFromCache({ profile: { id: 'user-1', email: 'a@example.com', displayName: 'A' } })).toEqual({
      userId: 'user-1',
      email: 'a@example.com',
    });
  });

  it('reads nothing from a signed-out or partial profile', () => {
    for (const data of [
      undefined,
      null,
      { profile: null },
      { profile: { id: 'user-1' } },
      { profile: { email: 'a@b.c' } },
    ]) {
      expect(profileAccountFromCache(data)).toBeNull();
    }
  });
});

describe('watchProfileEmailForDeviceTokens', () => {
  it('records the email whenever the profile cache entry succeeds, and nothing for other keys', async () => {
    const queryClient = new QueryClient();
    const stop = watchProfileEmailForDeviceTokens(queryClient);

    queryClient.setQueryData(['profile'], { profile: null });
    queryClient.setQueryData(['publicProfile', 'user-1'], { profile: { id: 'user-1', email: 'x@example.com' } });
    queryClient.setQueryData(['profile'], { profile: { id: 'user-1', email: 'a@example.com' } });
    await vi.waitFor(() => expect(rememberEmailMock).toHaveBeenCalledExactlyOnceWith('user-1', 'a@example.com'));

    stop();
    queryClient.setQueryData(['profile'], { profile: { id: 'user-2', email: 'b@example.com' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rememberEmailMock).toHaveBeenCalledOnce();
  });
});
