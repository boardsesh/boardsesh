// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_STANDINGS_PRIVACY, UPDATE_STANDINGS_PRIVACY } from '../../operations';

const state = vi.hoisted(() => ({
  offline: false,
  credentialGeneration: 1,
  request: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: (document: unknown, variables?: unknown) => {
      if (typeof document === 'object' && document !== null && 'document' in document) return state.read(document);
      return state.request(document, variables);
    },
  }),
}));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => state.credentialGeneration,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.credentialGeneration,
}));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: state.offline }),
}));

import { useStandingsPrivacy, useUpdateStandingsPrivacy, type StandingsPrivacy } from '../use-standings-privacy';

const original: StandingsPrivacy = { leaderboardVisibility: 'public', gymScreenVisibility: 'off' };
const originalKey = ['standingsPrivacy', 'viewer', 1];
const saved: StandingsPrivacy = { leaderboardVisibility: 'anonymous', gymScreenVisibility: 'off' };

function setup(onMutate?: () => Promise<void>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({ onMutate }),
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

beforeEach(() => {
  state.offline = false;
  state.credentialGeneration = 1;
  state.request.mockReset().mockResolvedValue({ updateProfile: saved });
  state.read.mockReset().mockResolvedValue({ profile: original });
});
afterEach(cleanup);

describe('standings privacy read', () => {
  it('loads consent separately from the shared profile document, with account-scoped cache', async () => {
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useStandingsPrivacy('viewer'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(original));
    expect(state.read).toHaveBeenCalledWith({ document: GET_STANDINGS_PRIVACY, signal: expect.any(AbortSignal) });
    expect(queryClient.getQueryData(originalKey)).toEqual(original);
    expect(queryClient.getQueryData(['profile'])).toBeUndefined();
  });

  it('does not start a query when signed out', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useStandingsPrivacy(undefined), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(state.read).not.toHaveBeenCalled();
  });

  it('does not show another account’s cached preference after switching viewers', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(originalKey, original);
    let resolveRead!: (response: { profile: StandingsPrivacy }) => void;
    state.read.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)));
    const { result } = renderHook(() => useStandingsPrivacy('replacement'), { wrapper });
    expect(result.current.data).toBeUndefined();
    resolveRead({ profile: saved });
    await waitFor(() => expect(result.current.data).toEqual(saved));
    expect(queryClient.getQueryData(originalKey)).toEqual(original);
  });

  it('rejects a response from a retired credential generation', async () => {
    const { queryClient, wrapper } = setup();
    let resolveRead!: (response: { profile: StandingsPrivacy }) => void;
    state.read.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)));
    renderHook(() => useStandingsPrivacy('viewer'), { wrapper });
    state.credentialGeneration += 1;
    resolveRead({ profile: saved });
    await waitFor(() => expect(queryClient.getQueryState(originalKey)?.status).toBe('error'));
    expect(queryClient.getQueryData(originalKey)).toBeUndefined();
  });
});

describe('standings privacy writes', () => {
  it('sends one explicit choice, preserves the other audience and refreshes affected screens', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(originalKey, original);
    queryClient.setQueryData(['boardLeaderboard', 'board'], ['old ranking']);
    queryClient.setQueryData(['profile'], { profile: { id: 'viewer', displayName: 'Alex' } });
    const { result } = renderHook(() => useUpdateStandingsPrivacy('viewer'), { wrapper });
    await act(async () => result.current.mutateAsync({ leaderboardVisibility: 'anonymous' }));
    expect(state.request).toHaveBeenCalledExactlyOnceWith(UPDATE_STANDINGS_PRIVACY, {
      input: { leaderboardVisibility: 'anonymous' },
    });
    expect(queryClient.getQueryData(originalKey)).toEqual(saved);
    expect(queryClient.getQueryState(['boardLeaderboard', 'board'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(['profile'])).toEqual({ profile: { id: 'viewer', displayName: 'Alex' } });
  });

  it('leaves an observed fresh server answer in place after saving', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(originalKey, original);
    const fresh: StandingsPrivacy = { leaderboardVisibility: 'anonymous', gymScreenVisibility: 'anonymous' };
    state.read.mockResolvedValue({ profile: fresh });
    const { result } = renderHook(
      () => ({ read: useStandingsPrivacy('viewer'), update: useUpdateStandingsPrivacy('viewer') }),
      { wrapper },
    );
    await act(async () => result.current.update.mutateAsync({ leaderboardVisibility: 'anonymous' }));
    expect(queryClient.getQueryData(originalKey)).toEqual(fresh);
  });

  it('keeps an acknowledged save when its fresh read fails', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(originalKey, original);
    state.read.mockRejectedValue(new Error('read disconnected'));
    const { result } = renderHook(
      () => ({ read: useStandingsPrivacy('viewer'), update: useUpdateStandingsPrivacy('viewer') }),
      { wrapper },
    );
    await act(async () => result.current.update.mutateAsync({ leaderboardVisibility: 'anonymous' }));
    expect(queryClient.getQueryData(originalKey)).toEqual(saved);
  });

  it('refuses offline writes instead of queuing them', async () => {
    state.offline = true;
    const { wrapper } = setup();
    const { result } = renderHook(() => useUpdateStandingsPrivacy('viewer'), { wrapper });
    await expect(result.current.mutateAsync({ gymScreenVisibility: 'off' })).rejects.toThrow('connection');
    expect(state.request).not.toHaveBeenCalled();
  });

  it('preserves the previous choice after a failed write', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(originalKey, original);
    state.request.mockRejectedValue(new Error('write disconnected'));
    const { result } = renderHook(() => useUpdateStandingsPrivacy('viewer'), { wrapper });
    await expect(result.current.mutateAsync({ leaderboardVisibility: 'anonymous' })).rejects.toThrow('disconnected');
    expect(queryClient.getQueryData(originalKey)).toEqual(original);
  });

  it.each(['viewer', 'credentials'] as const)('rejects late saves after a %s change', async (change) => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(originalKey, original);
    let acknowledge!: (response: { updateProfile: StandingsPrivacy }) => void;
    state.request.mockReturnValue(new Promise((resolve) => (acknowledge = resolve)));
    const { result, rerender } = renderHook(({ viewerId }) => useUpdateStandingsPrivacy(viewerId), {
      initialProps: { viewerId: 'viewer' },
      wrapper,
    });
    const succeeded = vi.fn();
    act(() => result.current.mutate({ leaderboardVisibility: 'anonymous' }, { onSuccess: succeeded }));
    await waitFor(() => expect(state.request).toHaveBeenCalledOnce());
    if (change === 'credentials') state.credentialGeneration += 1;
    rerender({ viewerId: change === 'viewer' ? 'replacement' : 'viewer' });
    acknowledge({ updateProfile: saved });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(originalKey)).toEqual(original);
    expect(succeeded).not.toHaveBeenCalled();
  });

  it('captures the invocation’s credentials before awaited mutation setup', async () => {
    let release!: () => void;
    const { wrapper } = setup(() => new Promise((resolve) => (release = resolve)));
    const { result, rerender } = renderHook(() => useUpdateStandingsPrivacy('viewer'), { wrapper });
    act(() => result.current.mutate({ leaderboardVisibility: 'anonymous' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    state.credentialGeneration += 1;
    rerender();
    release();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(state.request).not.toHaveBeenCalled();
  });
});
