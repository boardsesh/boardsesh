// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type QueryOptions = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<string[]>;
  enabled: boolean;
  staleTime: number;
  refetchOnWindowFocus: boolean;
  refetchOnReconnect: boolean;
};

const ctrl = vi.hoisted(() => ({
  options: [] as QueryOptions[],
  data: undefined as string[] | undefined,
  requests: [] as unknown[],
  response: { playlistsForClimb: [] as string[] },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: QueryOptions) => {
    ctrl.options.push(options);
    return { data: ctrl.data };
  },
}));

vi.mock('@boardsesh/graphql/operations/playlists', () => ({
  GET_PLAYLISTS_FOR_CLIMB: 'query GetPlaylistsForClimb',
}));

vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({
    request: async (_document: unknown, variables: unknown) => {
      ctrl.requests.push(variables);
      return ctrl.response;
    },
  }),
}));

import { useClimbPlaylistMembershipQuery } from '../use-climb-playlist-membership-query';

const baseArgs = { climbUuid: 'climb-1', boardName: 'kilter', layoutId: 8, enabled: true };

function latestOptions(): QueryOptions {
  const options = ctrl.options.at(-1);
  if (!options) throw new Error('useQuery was never called');
  return options;
}

describe('useClimbPlaylistMembershipQuery', () => {
  beforeEach(() => {
    ctrl.options = [];
    ctrl.data = undefined;
    ctrl.requests = [];
    ctrl.response = { playlistsForClimb: [] };
  });

  it('keys the cache by board, layout and climb', () => {
    // The add-to-playlist picker and the play-drawer chips must land on the SAME
    // entry — that is what makes an optimistic toggle in the sheet show up in the
    // header with no refetch. A change to this shape silently breaks that.
    renderHook(() => useClimbPlaylistMembershipQuery(baseArgs));
    expect(latestOptions().queryKey).toEqual(['playlistsForClimb', 'kilter', 8, 'climb-1']);
  });

  it('exposes the same key it queries under', () => {
    const { result } = renderHook(() => useClimbPlaylistMembershipQuery(baseArgs));
    expect(result.current.membershipKey).toEqual(latestOptions().queryKey);
  });

  it('holds a 30s stale window and never refetches on focus or reconnect', () => {
    // Load-bearing: optimistic toggle writes are the source of truth while a
    // climber is working, and a focus/reconnect refetch must not land a stale
    // membership set over a checkmark they just tapped.
    renderHook(() => useClimbPlaylistMembershipQuery(baseArgs));
    const options = latestOptions();
    expect(options.staleTime).toBe(30_000);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
  });

  it('passes the caller gate straight through to the query', () => {
    renderHook(() => useClimbPlaylistMembershipQuery({ ...baseArgs, enabled: false }));
    expect(latestOptions().enabled).toBe(false);
  });

  it('still serves cached data while disabled', () => {
    // How the swipe "peek" header paints without requesting anything.
    ctrl.data = ['playlist-1'];
    const { result } = renderHook(() => useClimbPlaylistMembershipQuery({ ...baseArgs, enabled: false }));
    expect(result.current.memberUuids).toEqual(['playlist-1']);
  });

  it('sends the climb and its board scope, and unwraps the response', async () => {
    ctrl.response = { playlistsForClimb: ['playlist-1', 'playlist-2'] };
    renderHook(() => useClimbPlaylistMembershipQuery(baseArgs));
    await expect(latestOptions().queryFn()).resolves.toEqual(['playlist-1', 'playlist-2']);
    expect(ctrl.requests).toEqual([{ input: { boardType: 'kilter', layoutId: 8, climbUuid: 'climb-1' } }]);
  });

  it('keeps the key referentially stable across re-renders with the same climb', () => {
    // The key is a dependency of the picker's optimistic-write callbacks; a fresh
    // array each render would churn them and every memoized row below.
    const { result, rerender } = renderHook(() => useClimbPlaylistMembershipQuery(baseArgs));
    const first = result.current.membershipKey;
    rerender();
    expect(result.current.membershipKey).toBe(first);
  });
});
