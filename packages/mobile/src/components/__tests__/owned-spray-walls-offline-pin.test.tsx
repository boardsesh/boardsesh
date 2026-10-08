// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

// The rules are `planOwnedSprayWallPins`'s test. This one checks the wiring:
// the gates, and that the pin and the unpin go through the paths the switch
// and Storage's Remove already use.

const state = vi.hoisted(() => ({
  isAuthenticated: true,
  downloadsEnabled: true,
  isOffline: false,
  userId: 'user-me' as string | undefined,
  boards: undefined as unknown[] | undefined,
  enabled: [] as string[],
  ledger: null as { userId: string; wallUuids: string[] } | null,
}));
const enableBoardsOffline = vi.hoisted(() => vi.fn());
const removeOfflineBoard = vi.hoisted(() => vi.fn(async () => ({})));
const setOwnedSprayWallPins = vi.hoisted(() =>
  vi.fn((ledger: { userId: string; wallUuids: string[] }) => {
    state.ledger = ledger;
  }),
);

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../db/use-offline-database', () => ({ useOfflineDatabase: () => ({}) }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.isAuthenticated }) }));
vi.mock('../../providers/feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => state.downloadsEnabled }));
vi.mock('../../hooks/use-current-user-id', () => ({ useStoredUserId: () => ({ userId: state.userId }) }));
vi.mock('../../hooks/use-is-offline', () => ({ useIsOffline: () => state.isOffline }));
vi.mock('../../lib/graphql/hooks', () => ({
  useMyBoards: (_input: unknown, options: { enabled: boolean }) => ({
    data: options.enabled && state.boards ? { boards: state.boards } : undefined,
  }),
}));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../offline/use-board-downloads', () => ({ useBoardDownloads: () => ({ enableBoardsOffline }) }));
vi.mock('../../offline/remove-offline-board', () => ({ removeOfflineBoard }));
vi.mock('../../settings', () => ({
  getOwnedSprayWallPins: () => state.ledger,
  getSetting: () => state.enabled,
  setOwnedSprayWallPins,
  useSetting: () => [state.enabled, vi.fn()],
}));

import { OwnedSprayWallsOfflinePin } from '../owned-spray-walls-offline-pin';

const myWall = { uuid: 'wall-a', boardType: 'spray', layoutId: 101, sizeId: 101, ownerId: 'user-me' };
const theirWall = { uuid: 'wall-b', boardType: 'spray', layoutId: 102, sizeId: 102, ownerId: 'user-someone' };

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.assign(state, {
    isAuthenticated: true,
    downloadsEnabled: true,
    isOffline: false,
    userId: 'user-me',
    boards: [myWall, theirWall],
    enabled: [],
    ledger: null,
  });
});

describe('OwnedSprayWallsOfflinePin', () => {
  it('turns on the owned wall through the switch’s own path', () => {
    render(createElement(OwnedSprayWallsOfflinePin));
    expect(enableBoardsOffline).toHaveBeenCalledTimes(1);
    expect(enableBoardsOffline).toHaveBeenCalledWith([myWall], { trigger: 'owned-wall', source: 'owned_wall' });
    expect(setOwnedSprayWallPins).toHaveBeenCalledWith({ userId: 'user-me', wallUuids: ['wall-a'] });
  });

  it('removes the download of a pinned wall that changed hands, the way Storage does', () => {
    state.boards = [{ ...myWall, ownerId: 'user-someone' }];
    state.ledger = { userId: 'user-me', wallUuids: ['wall-a'] };
    state.enabled = ['spray:101:101'];
    render(createElement(OwnedSprayWallsOfflinePin));
    expect(removeOfflineBoard).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { boardType: 'spray', layoutId: 101, sizeId: 101 } }),
    );
    expect(enableBoardsOffline).not.toHaveBeenCalled();
  });

  it.each([
    ['signed out', { isAuthenticated: false }],
    ['offline', { isOffline: true }],
    ['without offline downloads', { downloadsEnabled: false }],
    ['before the account id is known', { userId: undefined }],
  ])('does nothing %s', (_case, overrides) => {
    Object.assign(state, overrides);
    render(createElement(OwnedSprayWallsOfflinePin));
    expect(enableBoardsOffline).not.toHaveBeenCalled();
    expect(removeOfflineBoard).not.toHaveBeenCalled();
    expect(setOwnedSprayWallPins).not.toHaveBeenCalled();
  });
});
