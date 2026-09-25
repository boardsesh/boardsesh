// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Run scheduled interaction callbacks immediately — the deferral is covered by the
// shared `runAfterInteractions` contract, not by these tests.
const { runAfterInteractions, request, isAuthenticated, tagsSetting } = vi.hoisted(() => ({
  runAfterInteractions: vi.fn((callback: () => void) => {
    callback();
    return { cancel: vi.fn() };
  }),
  request: vi.fn(),
  isAuthenticated: { value: true },
  tagsSetting: { enabled: false },
}));

vi.mock('react-native', () => ({ InteractionManager: { runAfterInteractions } }));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: isAuthenticated.value }),
}));
vi.mock('../../lib/show-playlist-tags-preference', () => ({
  useShowPlaylistTagsPreference: () => ({ enabled: tagsSetting.enabled }),
}));

import { useClimbListPlaylistMemberships } from '../use-climb-list-playlist-memberships';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useClimbListPlaylistMemberships', () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ playlistsForClimbs: [] });
    runAfterInteractions.mockClear();
    isAuthenticated.value = true;
    tagsSetting.enabled = false;
  });

  it('asks for nothing while the tags setting is off', async () => {
    renderHook(() => useClimbListPlaylistMemberships({ boardName: 'kilter', layoutId: 1, climbUuids: ['a'] }));
    await flush();

    expect(request).not.toHaveBeenCalled();
  });

  // The rich density tier draws the tag line whatever the setting says, so the
  // store has to be filled or that line paints empty for every climber who left
  // the setting off — which is its default, i.e. almost everyone. Without
  // `force` the tier's headline feature ships dead.
  it('fetches for the rich tier even with the tags setting off', async () => {
    renderHook(() =>
      useClimbListPlaylistMemberships({ boardName: 'kilter', layoutId: 1, climbUuids: ['a'], force: true }),
    );
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.anything(), {
      input: { boardType: 'kilter', layoutId: 1, climbUuids: ['a'] },
    });
  });

  it('still fetches when the setting is on and nothing forces it', async () => {
    tagsSetting.enabled = true;

    renderHook(() => useClimbListPlaylistMemberships({ boardName: 'kilter', layoutId: 1, climbUuids: ['a'] }));
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when signed out, however it was forced', async () => {
    isAuthenticated.value = false;

    renderHook(() =>
      useClimbListPlaylistMemberships({ boardName: 'kilter', layoutId: 1, climbUuids: ['a'], force: true }),
    );
    await flush();

    expect(request).not.toHaveBeenCalled();
  });
});
