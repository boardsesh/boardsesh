// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_PLAYLISTS_FOR_CLIMBS } from '@boardsesh/graphql/operations/playlists';
import type { GetPlaylistsForClimbsQueryResponse } from '@boardsesh/graphql/operations/playlists';

const device = vi.hoisted(() => ({
  enabled: true,
  isAuthenticated: true,
  userId: 'user-a' as string | undefined,
  userLoading: false,
  refreshEpoch: 0,
  credentialGeneration: 0,
  protectedClimbs: new Set<string>(),
}));
const queryClient = vi.hoisted(() => ({}));
const { request, useStoredUserId, useUserReadRefresh, runAfterInteractions } = vi.hoisted(() => ({
  request: vi.fn(),
  useStoredUserId: vi.fn(),
  useUserReadRefresh: vi.fn(),
  runAfterInteractions: vi.fn((callback: () => void) => {
    callback();
    return { cancel: vi.fn() };
  }),
}));

vi.mock('react-native', () => ({ InteractionManager: { runAfterInteractions } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../lib/graphql/offline-user-read-recovery', () => ({
  isPlaylistMembershipWritePending: (_client: unknown, queryKey: readonly unknown[]) =>
    device.protectedClimbs.has(String(queryKey[3])),
}));
vi.mock('../../lib/graphql/offline-request', () => ({ offlineAwareRequest: request }));
vi.mock('../../lib/climb-row-display-preference', () => ({ useClimbRowField: () => device.enabled }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: device.isAuthenticated }) }));
vi.mock('../use-current-user-id', () => ({ useStoredUserId }));
vi.mock('../use-user-read-refresh', () => ({ useUserReadRefresh }));
vi.mock('../../lib/privacy/privacy-cache', () => ({
  getPrivacyRevocationGeneration: () => device.credentialGeneration,
}));

import { playlistMembershipStore } from '@boardsesh/climb-actions';
import { useClimbListPlaylistMemberships } from '../use-climb-list-playlist-memberships';

type MembershipResponse = GetPlaylistsForClimbsQueryResponse;
const emptyResponse: MembershipResponse = { playlistsForClimbs: [] };
const membershipsFor = (climbUuid: string): string[] => [...playlistMembershipStore.getMembershipsForClimb(climbUuid)];
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function deferredResponse() {
  let resolve: (response: MembershipResponse) => void = () => {};
  const promise = new Promise<MembershipResponse>((resolveResponse) => {
    resolve = resolveResponse;
  });
  return { promise, resolve: (response: MembershipResponse) => resolve(response) };
}

function mountList(climbUuids: readonly string[]) {
  return renderHook(
    (props: { climbUuids: readonly string[] }) =>
      useClimbListPlaylistMemberships({ boardName: 'kilter', layoutId: 1, ...props }),
    { initialProps: { climbUuids } },
  );
}

beforeEach(() => {
  playlistMembershipStore.reset();
  request.mockReset();
  request.mockResolvedValue(emptyResponse);
  runAfterInteractions.mockClear();
  device.enabled = true;
  device.isAuthenticated = true;
  device.userId = 'user-a';
  device.userLoading = false;
  device.refreshEpoch = 0;
  device.credentialGeneration = 0;
  device.protectedClimbs.clear();
  useStoredUserId.mockReset().mockImplementation(() => ({ userId: device.userId, isLoading: device.userLoading }));
  useUserReadRefresh.mockReset().mockImplementation(() => device.refreshEpoch);
});

describe('useClimbListPlaylistMemberships', () => {
  it("writes memberships for the requested climbs and clears omitted climbs' old tags", async () => {
    playlistMembershipStore.setMembershipForClimb('a', ['old-playlist']);
    playlistMembershipStore.setMembershipForClimb('offscreen', ['other-playlist']);
    request.mockResolvedValue({ playlistsForClimbs: [{ climbUuid: 'b', playlistUuids: ['playlist-1'] }] });

    mountList(['a', 'b']);
    await waitFor(() => expect(membershipsFor('b')).toEqual(['playlist-1']));

    expect(membershipsFor('a')).toEqual([]);
    expect(membershipsFor('offscreen')).toEqual(['other-playlist']);
    expect(request).toHaveBeenCalledWith(GET_PLAYLISTS_FOR_CLIMBS, {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: ['a', 'b'] },
    });
    expect(useStoredUserId).toHaveBeenCalledWith(true);
    expect(useUserReadRefresh).toHaveBeenCalledWith('playlists');
  });

  it('refetches already-fetched UUIDs after local-read recovery and removes stale tags', async () => {
    request.mockResolvedValueOnce({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['offline-projects'] }] });
    const { rerender } = mountList(['a']);
    await waitFor(() => expect(membershipsFor('a')).toEqual(['offline-projects']));

    device.refreshEpoch += 1;
    rerender({ climbUuids: ['a'] });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await flush();

    expect(membershipsFor('a')).toEqual([]);
    expect(request).toHaveBeenLastCalledWith(GET_PLAYLISTS_FOR_CLIMBS, {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: ['a'] },
    });
  });

  it('resets memberships when the account changes while authentication remains true', async () => {
    request.mockResolvedValueOnce({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['user-a-playlist'] }] });
    const { rerender } = mountList(['a']);
    await waitFor(() => expect(membershipsFor('a')).toEqual(['user-a-playlist']));

    device.userId = 'user-b';
    rerender({ climbUuids: ['a'] });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await flush();

    expect(device.isAuthenticated).toBe(true);
    expect(membershipsFor('a')).toEqual([]);
  });

  it.each([false, true])(
    'retains optimistic chips across recovery when the pending write settles before the read: %s',
    async (settlesBeforeRead) => {
      const climbUuids = ['a', 'b'];
      request.mockResolvedValueOnce({ playlistsForClimbs: [{ climbUuid: 'b', playlistUuids: ['old-b'] }] });
      const { rerender } = mountList(climbUuids);
      await flush();
      playlistMembershipStore.setMembershipForClimb('a', ['new-a']);
      device.protectedClimbs.add('a');
      const lookup = deferredResponse();
      request.mockReturnValueOnce(lookup.promise);
      device.refreshEpoch += 1;
      rerender({ climbUuids });
      expect(membershipsFor('a')).toEqual(['new-a']);
      expect(membershipsFor('b')).toEqual(['old-b']);
      if (settlesBeforeRead) device.protectedClimbs.delete('a');
      lookup.resolve({ playlistsForClimbs: [{ climbUuid: 'b', playlistUuids: ['new-b'] }] });
      await flush();
      expect(membershipsFor('a')).toEqual(['new-a']);
      expect(membershipsFor('b')).toEqual(['new-b']);
    },
  );

  it('drops an in-flight batch after a credential transition before auth renders again', async () => {
    const lookup = deferredResponse();
    request.mockReturnValueOnce(lookup.promise);
    mountList(['a']);
    expect(request).toHaveBeenCalledOnce();

    device.credentialGeneration += 1;
    lookup.resolve({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['previous-user-private-playlist'] }] });
    await flush();

    expect(membershipsFor('a')).toEqual([]);
  });

  it('keeps a picker add that lands while an older batch is awaiting its response', async () => {
    const lookup = deferredResponse();
    request.mockReturnValueOnce(lookup.promise);
    mountList(['a', 'b']);
    expect(request).toHaveBeenCalledOnce();

    playlistMembershipStore.setMembershipForClimb('a', ['new-playlist']);
    // The older answer omits a, but its unchanged b result still applies.
    lookup.resolve({ playlistsForClimbs: [{ climbUuid: 'b', playlistUuids: ['existing-playlist'] }] });
    await flush();

    expect(membershipsFor('a')).toEqual(['new-playlist']);
    expect(membershipsFor('b')).toEqual(['existing-playlist']);
  });

  it('keeps a picker removal when an older batch still reports the removed membership', async () => {
    playlistMembershipStore.setMembershipForClimb('a', ['removed-playlist']);
    const lookup = deferredResponse();
    request.mockReturnValueOnce(lookup.promise);
    mountList(['a']);
    expect(request).toHaveBeenCalledOnce();

    playlistMembershipStore.setMembershipForClimb('a', []);
    lookup.resolve({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['removed-playlist'] }] });
    await flush();

    expect(membershipsFor('a')).toEqual([]);
  });

  it("asks only for newly visible UUIDs while preserving earlier pages' memberships", async () => {
    request.mockResolvedValueOnce({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['projects'] }] });
    const { rerender } = mountList(['a']);
    await waitFor(() => expect(membershipsFor('a')).toEqual(['projects']));

    rerender({ climbUuids: ['a', 'b'] });
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(GET_PLAYLISTS_FOR_CLIMBS, {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: ['b'] },
    });
    expect(membershipsFor('a')).toEqual(['projects']);
  });

  it('releases cancelled UUID bookkeeping before the replacement effect runs', async () => {
    const firstLookup = deferredResponse();
    request.mockReturnValueOnce(firstLookup.promise);
    const { rerender } = mountList(['a']);
    expect(request).toHaveBeenCalledOnce();

    request.mockResolvedValue({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['current-playlist'] }] });
    rerender({ climbUuids: ['a', 'b'] });
    await waitFor(() => expect(membershipsFor('a')).toEqual(['current-playlist']));
    expect(request).toHaveBeenLastCalledWith(GET_PLAYLISTS_FOR_CLIMBS, {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: ['a', 'b'] },
    });

    firstLookup.resolve({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['obsolete-playlist'] }] });
    await flush();
    expect(membershipsFor('a')).toEqual(['current-playlist']);
  });

  it('chunks a long visible set into at most 500 UUIDs per request', async () => {
    const climbUuids = Array.from({ length: 1_205 }, (_, index) => `climb-${index}`);
    mountList(climbUuids);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await flush();

    const requestedChunks = request.mock.calls.map(
      ([, variables]) => (variables as { input: { climbUuids: string[] } }).input.climbUuids,
    );
    expect(requestedChunks.map((chunk) => chunk.length)).toEqual([500, 500, 205]);
    expect(requestedChunks.flat()).toEqual(climbUuids);
  });

  it('retries an unmerged later chunk without refetching the merged first chunk', async () => {
    const climbUuids = Array.from({ length: 600 }, (_, index) => `climb-${index}`);
    const secondChunk = deferredResponse();
    request.mockResolvedValueOnce(emptyResponse).mockReturnValueOnce(secondChunk.promise);
    const { rerender } = mountList(climbUuids);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    request.mockResolvedValue({ playlistsForClimbs: [{ climbUuid: 'climb-550', playlistUuids: ['retry-playlist'] }] });
    rerender({ climbUuids: [...climbUuids, 'climb-600'] });
    await waitFor(() => expect(membershipsFor('climb-550')).toEqual(['retry-playlist']));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith(GET_PLAYLISTS_FOR_CLIMBS, {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: [...climbUuids.slice(500), 'climb-600'] },
    });

    secondChunk.resolve(emptyResponse);
    await flush();
    expect(membershipsFor('climb-550')).toEqual(['retry-playlist']);
  });

  it('retries failed UUIDs on the next visible-window change', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    const { rerender } = mountList(['a']);
    await flush();

    request.mockResolvedValue({ playlistsForClimbs: [{ climbUuid: 'a', playlistUuids: ['projects'] }] });
    rerender({ climbUuids: ['a', 'b'] });
    await waitFor(() => expect(membershipsFor('a')).toEqual(['projects']));
    expect(request).toHaveBeenLastCalledWith(GET_PLAYLISTS_FOR_CLIMBS, {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: ['a', 'b'] },
    });
  });

  it('waits for the stored account ID before requesting memberships', async () => {
    device.userLoading = true;
    device.userId = undefined;
    const { rerender } = mountList(['a']);
    await flush();
    expect(request).not.toHaveBeenCalled();

    device.userLoading = false;
    device.userId = 'user-a';
    rerender({ climbUuids: ['a'] });
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
  });

  it.each(['signed-out', 'disabled', 'missing-account'])('does not request memberships when %s', async (gate) => {
    if (gate === 'signed-out') device.isAuthenticated = false;
    if (gate === 'disabled') device.enabled = false;
    if (gate === 'missing-account') device.userId = undefined;
    mountList(['a']);
    await flush();
    expect(request).not.toHaveBeenCalled();
  });
});
