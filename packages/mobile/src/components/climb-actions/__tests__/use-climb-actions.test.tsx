// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionId } from '../use-climb-actions';

const ctrl = vi.hoisted(() => ({ canUpdate: false }));
const openers = vi.hoisted(() => ({
  openPlayDrawer: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openLogAscent: vi.fn(),
  openAddBetaVideo: vi.fn(),
  addToQueue: vi.fn(),
  toggleFavoriteMutate: vi.fn(),
  push: vi.fn(),
  shareClimb: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: openers.push }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-uuid' }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => {}) }));
vi.mock('@boardsesh/create-climb-react', () => ({ computeCanUpdate: () => ctrl.canUpdate }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    openPlayDrawer: openers.openPlayDrawer,
    openAddToPlaylist: openers.openAddToPlaylist,
    openLogAscent: openers.openLogAscent,
    openAddBetaVideo: openers.openAddBetaVideo,
    boardConfig: null,
  }),
  boardConfigsMatch: () => false,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ addToQueue: openers.addToQueue }),
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: (climb: unknown) => ({ uuid: 'qi', climb }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    actionColors: { success: '#0a0', favorite: '#f00', accent: '#00f', neutral: '#fff', pin: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: openers.toggleFavoriteMutate }),
  useFavoriteStatus: () => ({ data: false }),
}));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => openers.shareClimb }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

import { useClimbActions } from '../use-climb-actions';

const climb = {
  uuid: 'climb-1',
  name: 'Test Climb',
  frames: 'p1r12',
  difficulty: 'V4',
  quality_average: '3.0',
} as unknown as Climb;

const ownerClimb = { ...climb, userId: 'user-1', is_draft: true } as unknown as Climb;

const kilterBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const tensionBoard = { ...kilterBoard, boardName: 'tension' };

function ids(args: Parameters<typeof useClimbActions>[0]): ClimbActionId[] {
  const { result } = renderHook(() => useClimbActions(args));
  return result.current.map((action) => action.id);
}

beforeEach(() => {
  ctrl.canUpdate = false;
  Object.values(openers).forEach((fn) => fn.mockClear?.());
});

describe('useClimbActions gating', () => {
  it('returns the universal actions for a plain Kilter climb (no edit/beta/openInApp/editEntry)', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).toEqual([
      'preview',
      'queue',
      'playlist',
      'favorite',
      'tick',
      'fork',
      'share',
    ]);
  });

  it('adds "Edit entry" only when onEditEntry is provided', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false, onEditEntry: () => {} })).toContain(
      'editEntry',
    );
  });

  it('adds "Add beta video" only when authenticated', () => {
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: true })).toContain('betaVideo');
  });

  it('adds "Open in app" for Tension but not Kilter', () => {
    expect(ids({ climb, boardConfig: tensionBoard, isAuthenticated: false })).toContain('openInApp');
    expect(ids({ climb, boardConfig: kilterBoard, isAuthenticated: false })).not.toContain('openInApp');
  });

  it('adds owner-only "Edit" only when the climb is editable by the current user', () => {
    ctrl.canUpdate = true;
    expect(
      ids({ climb: ownerClimb, boardConfig: kilterBoard, isAuthenticated: false, currentUserId: 'user-1' }),
    ).toContain('edit');
    // Not the owner → no edit row.
    expect(
      ids({ climb: ownerClimb, boardConfig: kilterBoard, isAuthenticated: false, currentUserId: 'someone-else' }),
    ).not.toContain('edit');
  });

  it('returns nothing without a climb or board config', () => {
    expect(ids({ climb: null, boardConfig: kilterBoard, isAuthenticated: true })).toEqual([]);
    expect(ids({ climb, boardConfig: null, isAuthenticated: true })).toEqual([]);
  });
});

describe('useClimbActions colours and dispatch', () => {
  it('colours queue/favorite by role and the rest with the accent', () => {
    const { result } = renderHook(() => useClimbActions({ climb, boardConfig: kilterBoard, isAuthenticated: false }));
    const byId = Object.fromEntries(result.current.map((action) => [action.id, action.color]));
    expect(byId.queue).toBe('#0a0');
    expect(byId.favorite).toBe('#f00');
    expect(byId.playlist).toBe('#00f');
  });

  it('queue.run enqueues the climb and fires onAfterAction', () => {
    const onAfterAction = vi.fn();
    const { result } = renderHook(() =>
      useClimbActions({ climb, boardConfig: kilterBoard, isAuthenticated: false, onAfterAction }),
    );
    result.current.find((action) => action.id === 'queue')?.run();
    expect(openers.addToQueue).toHaveBeenCalledWith({ uuid: 'queue-uuid', climb });
    expect(onAfterAction).toHaveBeenCalledTimes(1);
  });

  it('playlist.run opens the playlist picker for the climb + board config', () => {
    const { result } = renderHook(() => useClimbActions({ climb, boardConfig: kilterBoard, isAuthenticated: false }));
    result.current.find((action) => action.id === 'playlist')?.run();
    expect(openers.openAddToPlaylist).toHaveBeenCalledWith(climb, kilterBoard);
  });

  it('share.run opens the native share sheet', () => {
    const { result } = renderHook(() => useClimbActions({ climb, boardConfig: kilterBoard, isAuthenticated: false }));
    result.current.find((action) => action.id === 'share')?.run();
    expect(openers.shareClimb).toHaveBeenCalledTimes(1);
  });

  it('preview.run opens the climb view-only in the play drawer', () => {
    const { result } = renderHook(() => useClimbActions({ climb, boardConfig: kilterBoard, isAuthenticated: false }));
    result.current.find((action) => action.id === 'preview')?.run();
    expect(openers.openPlayDrawer).toHaveBeenCalledTimes(1);
    expect(openers.openPlayDrawer).toHaveBeenCalledWith(climb, expect.objectContaining({ source: 'climb_view' }));
  });
});
