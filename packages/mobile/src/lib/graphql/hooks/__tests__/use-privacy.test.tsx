// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacySettings } from '@boardsesh/graphql/operations/privacy';
const state = vi.hoisted(() => ({ offline: false, request: vi.fn() }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: state.request }) }));
vi.mock('../index', () => ({ useProfile: () => ({ data: { id: 'viewer' } }) }));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: state.offline }),
}));
import { useUpdatePrivacySettings, usePrivacyFollowAction, useProfilePrivacy } from '../use-privacy';

const original: PrivacySettings = {
  enabled: true,
  isPrivate: false,
  privacyRevision: 1,
  privacyOnboardingVersion: 0,
  defaultSessionAudience: 'public',
};
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['privacySettings', 'viewer'], original);
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}
beforeEach(() => {
  state.offline = false;
  state.request.mockReset();
});
describe('privacy writes', () => {
  it('only completes onboarding and shows private after server acknowledgement', async () => {
    const { queryClient, wrapper } = setup();
    let acknowledge!: (response: { updatePrivacySettings: PrivacySettings }) => void;
    state.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { result } = renderHook(() => useUpdatePrivacySettings(), { wrapper });
    act(() => result.current.mutate({ isPrivate: true, privacyOnboardingVersion: 1 }));
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(queryClient.getQueryData(['privacySettings', 'viewer'])).toEqual(original);
    acknowledge({
      updatePrivacySettings: { ...original, isPrivate: true, privacyRevision: 2, privacyOnboardingVersion: 1 },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<PrivacySettings>(['privacySettings', 'viewer'])?.privacyOnboardingVersion).toBe(1);
    queryClient.clear();
  });
  it('preserves saved settings and onboarding state after server failure', async () => {
    const { queryClient, wrapper } = setup();
    state.request.mockRejectedValue(new Error('network disconnected'));
    const { result } = renderHook(() => useUpdatePrivacySettings(), { wrapper });
    act(() => result.current.mutate({ isPrivate: true, privacyOnboardingVersion: 1 }));
    await waitFor(() => expect(result.current.isError).toBe(true));
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
