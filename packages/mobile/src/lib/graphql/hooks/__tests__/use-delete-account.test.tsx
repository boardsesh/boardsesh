// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_DELETE_ACCOUNT_INFO, DELETE_ACCOUNT } from '@boardsesh/graphql/operations/account';

// These hooks back the App Store-required account-deletion flow. Pin: the info
// query surfaces the published-climb count (those climbs survive deletion, so
// the screen offers to strip the setter name), and the mutation forwards the
// removeSetterName choice and returns the server's boolean. Import the hook file
// directly (not the barrel) so we only mock the GraphQL client — the barrel
// transitively pulls react-native / expo via its other re-exports.
const requestMock = vi.fn();
const credentials = vi.hoisted(() => ({
  generation: 1,
  getToken: vi.fn(),
  confirmedUserId: undefined as string | undefined,
  browserOwner: null as { userId: string; authSessionId: string } | null,
}));
const forgetSignupConversionMock = vi.hoisted(() => vi.fn(async (_userId: string): Promise<void> => {}));
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => credentials.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === credentials.generation,
  getAuthToken: credentials.getToken,
}));
vi.mock('../../../verified-auth-result', () => ({
  getVerifiedAuthResult: () => (credentials.confirmedUserId ? { userId: credentials.confirmedUserId } : null),
}));
vi.mock('../../../user-storage-owner', () => ({
  getCurrentUserStorageOwner: () => credentials.browserOwner,
}));
vi.mock('../../../signup-conversion', () => ({ forgetSignupConversion: forgetSignupConversionMock }));

import { useDeleteAccountInfo, useDeleteAccount } from '../use-delete-account';

function makeWrapper(onMutate?: () => Promise<void>) {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache(onMutate ? { onMutate } : {}),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper };
}

beforeEach(() => {
  requestMock.mockReset();
  credentials.generation = 1;
  credentials.getToken.mockReset().mockResolvedValue(tokenFor('602c83bf-e090-4c90-9f7e-000000000080'));
  credentials.confirmedUserId = undefined;
  credentials.browserOwner = null;
  forgetSignupConversionMock.mockReset().mockResolvedValue(undefined);
});

function tokenFor(userId: string): string {
  return `header.${btoa(JSON.stringify({ sub: userId })).replace(/=/g, '')}.signature`;
}

describe('useDeleteAccountInfo', () => {
  it('selects the published-climb count from the response', async () => {
    requestMock.mockResolvedValue({ deleteAccountInfo: { publishedClimbCount: 7 } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccountInfo(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(7);
    expect(requestMock).toHaveBeenCalledWith(GET_DELETE_ACCOUNT_INFO);
  });

  it('does not fetch when disabled', async () => {
    requestMock.mockResolvedValue({ deleteAccountInfo: { publishedClimbCount: 0 } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccountInfo({ enabled: false }), { wrapper: Wrapper });

    // A disabled query reports fetchStatus 'idle' and never fires its queryFn —
    // assert on that state rather than racing a real timer.
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('useDeleteAccount', () => {
  it('forwards removeSetterName and returns the server boolean', async () => {
    requestMock.mockResolvedValue({ deleteAccount: true });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    const deleted = await result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: true } });

    expect(deleted).toMatchObject({ deleted: true, intent: { credentialGeneration: 1 } });
    expect(requestMock).toHaveBeenCalledWith(DELETE_ACCOUNT, { input: { removeSetterName: true } });
  });

  it('surfaces a rejected mutation to the caller', async () => {
    credentials.getToken.mockResolvedValue(tokenFor('602c83bf-e090-4c90-9f7e-000000000081'));
    requestMock.mockRejectedValue(new Error('boom'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).rejects.toThrow('boom');
    expect(forgetSignupConversionMock).not.toHaveBeenCalled();
  });

  it('forgets only the captured account after confirmed deletion', async () => {
    const userId = '602c83bf-e090-4c90-9f7e-000000000082';
    credentials.getToken.mockResolvedValue(tokenFor(userId));
    requestMock.mockResolvedValue({ deleteAccount: true });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).resolves.toMatchObject({ deleted: true, intent: { credentialGeneration: 1 } });

    expect(forgetSignupConversionMock).toHaveBeenCalledExactlyOnceWith(userId);
    expect(credentials.getToken.mock.invocationCallOrder[0]).toBeLessThan(requestMock.mock.invocationCallOrder[0]);
  });

  it('retains the account marker when the mutation returns false', async () => {
    credentials.getToken.mockResolvedValue(tokenFor('602c83bf-e090-4c90-9f7e-000000000083'));
    requestMock.mockResolvedValue({ deleteAccount: false });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).resolves.toEqual({ deleted: false });

    expect(forgetSignupConversionMock).not.toHaveBeenCalled();
  });

  it('does not clean a marker after credentials change during server deletion', async () => {
    credentials.getToken.mockResolvedValue(tokenFor('602c83bf-e090-4c90-9f7e-000000000084'));
    requestMock.mockImplementation(async () => {
      credentials.generation += 1;
      return { deleteAccount: true };
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).resolves.toMatchObject({ deleted: true, intent: { credentialGeneration: 1 } });

    expect(forgetSignupConversionMock).not.toHaveBeenCalled();
  });

  it('rejects a replaced credential owner before sending the mutation', async () => {
    let finishTokenRead: (token: string) => void = () => {};
    credentials.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishTokenRead = resolve;
        }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });
    const mutation = result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } });
    const rejected = expect(mutation).rejects.toThrow('Account credentials changed before account deletion');
    await waitFor(() => expect(credentials.getToken).toHaveBeenCalledOnce());
    credentials.generation += 1;
    finishTokenRead(tokenFor('602c83bf-e090-4c90-9f7e-000000000085'));

    await rejected;

    expect(requestMock).not.toHaveBeenCalled();
    expect(forgetSignupConversionMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'failed'] as const)(
    'does not block successful deletion on %s marker cleanup',
    async (cleanupState) => {
      credentials.getToken.mockResolvedValue(tokenFor('602c83bf-e090-4c90-9f7e-000000000086'));
      requestMock.mockResolvedValue({ deleteAccount: true });
      if (cleanupState === 'failed') forgetSignupConversionMock.mockRejectedValue(new Error('storage unavailable'));
      else forgetSignupConversionMock.mockReturnValue(new Promise<void>(() => {}));
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

      await expect(
        result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
      ).resolves.toMatchObject({ deleted: true, intent: { credentialGeneration: 1 } });

      expect(forgetSignupConversionMock).toHaveBeenCalledOnce();
    },
  );

  it('retains a confirmed owner when the local JWT read is temporarily unavailable', async () => {
    credentials.confirmedUserId = '602c83bf-e090-4c90-9f7e-000000000085';
    credentials.getToken.mockRejectedValue(new Error('keychain unavailable'));
    requestMock.mockResolvedValue({ deleteAccount: true });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).resolves.toMatchObject({ deleted: true, intent: { credentialGeneration: 1 } });

    expect(forgetSignupConversionMock).toHaveBeenCalledWith(credentials.confirmedUserId);
  });

  it('rejects the confirm intent before reading a newer owner after TanStack onMutate waits', async () => {
    let resumeMutation = () => {};
    let enterMutation = () => {};
    const entered = new Promise<void>((resolve) => {
      enterMutation = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resumeMutation = resolve;
    });
    const { Wrapper } = makeWrapper(async () => {
      enterMutation();
      await release;
    });
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });
    const deletion = result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } });
    await entered;
    credentials.generation = 2;
    credentials.getToken.mockResolvedValue(tokenFor('new-owner-b'));
    resumeMutation();

    await expect(deletion).rejects.toThrow('Account credentials changed before account deletion');
    expect(credentials.getToken).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(forgetSignupConversionMock).not.toHaveBeenCalled();
  });

  it('does not send a destructive request without any confirmed credential owner', async () => {
    credentials.getToken.mockRejectedValue(new Error('keychain unavailable'));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).rejects.toThrow('Unable to confirm the account before deletion');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('captures the settled browser owner for an opaque JWE without returning the credential', async () => {
    const credential = 'opaque.encrypted.web.session.token';
    credentials.getToken.mockResolvedValue(credential);
    credentials.browserOwner = { userId: 'browser-owner', authSessionId: 'browser-login' };
    requestMock.mockResolvedValue({ deleteAccount: true });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    const deletion = await result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } });
    expect(deletion).toEqual({ deleted: true, intent: { credentialGeneration: 1, userId: 'browser-owner' } });
    expect(JSON.stringify(deletion)).not.toContain(credential);
    expect(requestMock).toHaveBeenCalledWith(DELETE_ACCOUNT, { input: { removeSetterName: false } });
  });

  it('does not dispatch when the credential and already confirmed owner disagree', async () => {
    credentials.confirmedUserId = 'owner-a';
    credentials.getToken.mockResolvedValue(tokenFor('owner-b'));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ credentialGeneration: 1, input: { removeSetterName: false } }),
    ).rejects.toThrow('Account credentials changed before account deletion');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
