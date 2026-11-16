// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_PRIVACY_SETTINGS, type PrivacySettings } from '@boardsesh/graphql/operations/privacy';
const state = vi.hoisted(() => ({
  offline: false,
  viewerId: 'viewer',
  credentialGeneration: 1,
  request: vi.fn(),
  readSettings: vi.fn(),
}));
vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: (document: unknown, ...arguments_: unknown[]) => {
      if (
        typeof document === 'object' &&
        document !== null &&
        'document' in document &&
        document.document === GET_PRIVACY_SETTINGS
      )
        return state.readSettings();
      return state.request(document, ...arguments_);
    },
  }),
}));
vi.mock('../index', () => ({ useProfile: () => ({ data: { id: state.viewerId } }) }));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => state.credentialGeneration,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.credentialGeneration,
}));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: state.offline }),
}));
import {
  useSetAnonymousOnForeignBoards,
  useUpdatePrivacySettings,
  usePrivacyFollowAction,
  useProfilePrivacy,
  usePrivacySettings,
} from '../use-privacy';

const original: PrivacySettings = {
  enabled: true,
  isPrivate: false,
  privacyRevision: 1,
  defaultSessionAudience: 'public',
  anonymousOnForeignBoards: false,
};
function SettingsReader() {
  usePrivacySettings();
  return null;
}
function setup(onMutate?: () => Promise<void>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({ onMutate }),
  });
  queryClient.setQueryData(['privacySettings', 'viewer'], original);
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, createElement(SettingsReader), children),
  };
}
beforeEach(() => {
  state.offline = false;
  state.viewerId = 'viewer';
  state.credentialGeneration = 1;
  state.request.mockReset();
  state.readSettings.mockReset().mockResolvedValue({ privacySettings: original });
});
describe('privacy writes', () => {
  it('only shows private after server acknowledgement', async () => {
    const { queryClient, wrapper } = setup();
    let acknowledge!: (response: { updatePrivacySettings: PrivacySettings }) => void;
    state.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { result } = renderHook(() => useUpdatePrivacySettings(), { wrapper });
    act(() => result.current.mutate({ isPrivate: true }));
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(original);
    const savedSettings = { ...original, isPrivate: true, privacyRevision: 2 };
    state.readSettings.mockResolvedValue({ privacySettings: savedSettings });
    acknowledge({ updatePrivacySettings: savedSettings });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<PrivacySettings>(['privacySettings', 'viewer'])?.isPrivate).toBe(true);
    queryClient.clear();
  });
  it('preserves saved settings after server failure', async () => {
    const { queryClient, wrapper } = setup();
    state.request.mockRejectedValue(new Error('network disconnected'));
    const { result } = renderHook(() => useUpdatePrivacySettings(), { wrapper });
    act(() => result.current.mutate({ isPrivate: true }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(original);
    queryClient.clear();
  });
  it('saves the anonymous-on-boards choice and keeps the freshly read server answer', async () => {
    const { queryClient, wrapper } = setup();
    const savedSettings = { ...original, enabled: false, anonymousOnForeignBoards: true };
    state.request.mockResolvedValue({ setAnonymousOnForeignBoards: savedSettings });
    state.readSettings.mockResolvedValue({ privacySettings: savedSettings });
    const { result } = renderHook(() => useSetAnonymousOnForeignBoards(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.request).toHaveBeenCalledWith(expect.anything(), { enabled: true });
    expect(queryClient.getQueryData<PrivacySettings>(['privacySettings', 'viewer'])?.anonymousOnForeignBoards).toBe(
      true,
    );
    queryClient.clear();
  });
  it('keeps the saved anonymity switch on screen when the refetch after saving fails', async () => {
    const { queryClient, wrapper } = setup();
    const savedSettings = { ...original, anonymousOnForeignBoards: true };
    state.request.mockResolvedValue({ setAnonymousOnForeignBoards: savedSettings });
    state.readSettings.mockRejectedValue(new Error('network dropped after the save'));
    const { result } = renderHook(() => useSetAnonymousOnForeignBoards(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.readSettings).toHaveBeenCalled();
    expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(savedSettings);
    queryClient.clear();
  });
  it('prefers the fresh read over the save response when the refetch succeeds', async () => {
    const { queryClient, wrapper } = setup();
    const response = { ...original, anonymousOnForeignBoards: true };
    const freshRead = { ...original, anonymousOnForeignBoards: true, privacyRevision: 7 };
    state.request.mockResolvedValue({ setAnonymousOnForeignBoards: response });
    state.readSettings.mockResolvedValue({ privacySettings: freshRead });
    const { result } = renderHook(() => useSetAnonymousOnForeignBoards(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(freshRead);
    queryClient.clear();
  });
  it.each(['account', 'anonymous'] as const)(
    'keeps both saved fields when the %s response arrives last',
    async (lastResponse) => {
      const { queryClient, wrapper } = setup();
      let finishAccount!: (response: { updatePrivacySettings: PrivacySettings }) => void;
      let finishAnonymous!: (response: { setAnonymousOnForeignBoards: PrivacySettings }) => void;
      state.request.mockImplementation((_document: unknown, variables: { input?: unknown; enabled?: boolean }) =>
        variables.input
          ? new Promise((resolve) => {
              finishAccount = resolve;
            })
          : new Promise((resolve) => {
              finishAnonymous = resolve;
            }),
      );
      const { result } = renderHook(
        () => ({
          account: useUpdatePrivacySettings(),
          anonymous: useSetAnonymousOnForeignBoards(),
        }),
        { wrapper },
      );
      act(() => {
        result.current.account.mutate({ isPrivate: true });
        result.current.anonymous.mutate(true);
      });
      await waitFor(() => expect(state.request).toHaveBeenCalledTimes(2));
      // Both writes committed; each delayed mutation reply has an older full snapshot.
      const savedSettings = { ...original, isPrivate: true, privacyRevision: 2, anonymousOnForeignBoards: true };
      state.readSettings.mockResolvedValue({ privacySettings: savedSettings });
      const finish = {
        account: () => finishAccount({ updatePrivacySettings: { ...original, isPrivate: true, privacyRevision: 2 } }),
        anonymous: () =>
          finishAnonymous({ setAnonymousOnForeignBoards: { ...original, anonymousOnForeignBoards: true } }),
      };
      const firstResponse = lastResponse === 'account' ? 'anonymous' : 'account';
      await act(async () => finish[firstResponse]());
      await waitFor(() => expect(result.current[firstResponse].isSuccess).toBe(true));
      expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(savedSettings);
      await act(async () => finish[lastResponse]());
      await waitFor(() => expect(result.current[lastResponse].isSuccess).toBe(true));
      expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(savedSettings);
      queryClient.clear();
    },
  );

  it.each(['account', 'anonymous'] as const)("rejects the previous viewer's late %s save", async (action) => {
    const { queryClient, wrapper } = setup();
    let finish!: (response: {
      updatePrivacySettings: PrivacySettings;
      setAnonymousOnForeignBoards: PrivacySettings;
    }) => void;
    state.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const succeeded = vi.fn();
    const { result, rerender } = renderHook(
      () => ({
        account: useUpdatePrivacySettings(),
        anonymous: useSetAnonymousOnForeignBoards(),
      }),
      { wrapper },
    );
    act(() => {
      if (action === 'account') result.current.account.mutate({ isPrivate: true }, { onSuccess: succeeded });
      else result.current.anonymous.mutate(true, { onSuccess: succeeded });
    });
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(1));
    state.viewerId = 'replacement-viewer';
    state.credentialGeneration += 1;
    const replacementSettings = { ...original, privacyRevision: 9, anonymousOnForeignBoards: true };
    queryClient.setQueryData(['privacySettings', 'replacement-viewer'], replacementSettings);
    rerender();
    await act(async () => finish({ updatePrivacySettings: original, setAnonymousOnForeignBoards: original }));
    await waitFor(() => expect(result.current[action].isError).toBe(true));
    expect(succeeded).not.toHaveBeenCalled();
    expect(state.readSettings).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['privacySettings', 'replacement-viewer'])).toEqual(replacementSettings);
    queryClient.clear();
  });

  it.each(['account', 'anonymous'] as const)(
    'rejects %s input queued before a viewer switch, before sending it',
    async (action) => {
      let release!: () => void;
      const beforeRequest = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { queryClient, wrapper } = setup(beforeRequest);
      const succeeded = vi.fn();
      const { result, rerender } = renderHook(
        () => ({
          account: useUpdatePrivacySettings(),
          anonymous: useSetAnonymousOnForeignBoards(),
        }),
        { wrapper },
      );
      act(() => {
        if (action === 'account') result.current.account.mutate({ isPrivate: true }, { onSuccess: succeeded });
        else result.current.anonymous.mutate(true, { onSuccess: succeeded });
      });
      await waitFor(() => expect(beforeRequest).toHaveBeenCalledTimes(1));
      expect(state.request).not.toHaveBeenCalled();
      state.viewerId = 'replacement-viewer';
      state.credentialGeneration += 1;
      const replacementSettings = { ...original, privacyRevision: 9, anonymousOnForeignBoards: true };
      queryClient.setQueryData(['privacySettings', 'replacement-viewer'], replacementSettings);
      rerender();
      await act(async () => release());
      await waitFor(() => expect(result.current[action].isError).toBe(true));
      expect(state.request).not.toHaveBeenCalled();
      expect(succeeded).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(['privacySettings', 'replacement-viewer'])).toEqual(replacementSettings);
      queryClient.clear();
    },
  );

  it('refuses the anonymous-on-boards switch offline and keeps the saved value', async () => {
    state.offline = true;
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useSetAnonymousOnForeignBoards(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(state.request).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(original);
    queryClient.clear();
  });
  it('refuses offline writes instead of queueing an apparent privacy change', async () => {
    state.offline = true;
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => usePrivacyFollowAction(), { wrapper });
    act(() => result.current.mutate({ action: 'approve', userId: 'requester' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(state.request).not.toHaveBeenCalled();
    queryClient.clear();
  });
});

describe('privacy reads during a controls rollback', () => {
  it('still reads the private profile activity boundary', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(['privacySettings', 'viewer'], { ...original, enabled: false });
    state.request.mockResolvedValue({ publicProfile: { isPrivate: true, canViewActivity: false } });
    const { result } = renderHook(() => useProfilePrivacy('private-climber'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ isPrivate: true, canViewActivity: false }));
    queryClient.clear();
  });
});
