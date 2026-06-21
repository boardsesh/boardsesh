import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

vi.mock('../playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: vi.fn(),
}));

import { getBoardConfigForPlaylist } from '../playlists/board-details-for-playlist';
import { openClimbInPlayDrawer } from '../open-climb-in-play-drawer';
import type { TickLike } from '../tick-to-climb';

const mockedGetBoardConfig = vi.mocked(getBoardConfigForPlaylist);

const KILTER_CONFIG = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: [1, 20, 33] };

function makeDeps() {
  return { openPlayDrawer: vi.fn(), router: { push: vi.fn() } };
}

function makeTick(overrides: Partial<TickLike> = {}): TickLike {
  return {
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    frames: 'p1145r12',
    angle: 40,
    difficultyName: 'V4',
    quality: 3,
    setterUsername: 'setter',
    isBenchmark: false,
    isMirror: false,
    isNoMatch: false,
    boardType: 'kilter',
    layoutId: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('openClimbInPlayDrawer', () => {
  it('kind:climb opens active by default (no preview), tagged as a climb-view', () => {
    const deps = makeDeps();
    const climb = { uuid: 'c-1', name: 'X' } as Climb;
    const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20,33', angle: 40 };
    // Default is now "set active": no previewQueueItem (pressing a climb plays it).
    openClimbInPlayDrawer({ kind: 'climb', climb, boardConfig }, deps);
    expect(deps.openPlayDrawer).toHaveBeenCalledWith(climb, {
      boardConfig,
      source: 'climb_view',
    });
    expect(deps.router.push).not.toHaveBeenCalled();
  });

  it('kind:climb with preview:true opens a view-only preview (previewQueueItem set)', () => {
    const deps = makeDeps();
    const climb = { uuid: 'c-1', name: 'X' } as Climb;
    const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20,33', angle: 40 };
    openClimbInPlayDrawer({ kind: 'climb', climb, boardConfig }, deps, { preview: true });
    expect(deps.openPlayDrawer).toHaveBeenCalledWith(climb, {
      previewQueueItem: expect.objectContaining({ climb: expect.objectContaining({ uuid: 'c-1' }) }),
      boardConfig,
      source: 'climb_view',
    });
  });

  it('kind:tick with frames opens active by default with a resolved board config (no route push)', () => {
    mockedGetBoardConfig.mockReturnValue(KILTER_CONFIG);
    const deps = makeDeps();
    openClimbInPlayDrawer({ kind: 'tick', tick: makeTick({ angle: 50 }) }, deps);
    expect(deps.openPlayDrawer).toHaveBeenCalledTimes(1);
    const [, options] = deps.openPlayDrawer.mock.calls[0];
    expect(options).toMatchObject({
      boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20,33', angle: 50 },
      source: 'climb_view',
    });
    expect(options.previewQueueItem).toBeUndefined();
    expect(deps.router.push).not.toHaveBeenCalled();
  });

  it('kind:tick with preview:true opens a view-only preview', () => {
    mockedGetBoardConfig.mockReturnValue(KILTER_CONFIG);
    const deps = makeDeps();
    openClimbInPlayDrawer({ kind: 'tick', tick: makeTick({ angle: 50 }) }, deps, { preview: true });
    const [, options] = deps.openPlayDrawer.mock.calls[0];
    expect(options.previewQueueItem?.climb?.uuid).toBe('climb-1');
  });

  it('kind:tick without frames falls back to the climb route', () => {
    mockedGetBoardConfig.mockReturnValue(KILTER_CONFIG);
    const deps = makeDeps();
    openClimbInPlayDrawer({ kind: 'tick', tick: makeTick({ frames: null, climbUuid: 'c-2', angle: 45 }) }, deps);
    expect(deps.openPlayDrawer).not.toHaveBeenCalled();
    expect(deps.router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/[climbUuid]',
      params: { climbUuid: 'c-2', boardName: 'kilter', layoutId: '1', sizeId: '10', setIds: '1,20,33', angle: '45' },
    });
  });

  it('kind:tick with frames but an unresolvable board is a no-op (e.g. MoonBoard)', () => {
    mockedGetBoardConfig.mockReturnValue(null);
    const deps = makeDeps();
    openClimbInPlayDrawer({ kind: 'tick', tick: makeTick({ boardType: 'moonboard' }) }, deps);
    expect(deps.openPlayDrawer).not.toHaveBeenCalled();
    expect(deps.router.push).not.toHaveBeenCalled();
  });

  it('kind:ref with explicit size/sets pushes the route without resolving', () => {
    const deps = makeDeps();
    openClimbInPlayDrawer(
      { kind: 'ref', climbUuid: 'c-3', boardType: 'kilter', layoutId: 1, angle: 40, sizeId: 12, setIds: '1,2' },
      deps,
    );
    expect(mockedGetBoardConfig).not.toHaveBeenCalled();
    expect(deps.router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/[climbUuid]',
      params: { climbUuid: 'c-3', boardName: 'kilter', layoutId: '1', sizeId: '12', setIds: '1,2', angle: '40' },
    });
  });

  it('kind:ref without size/sets resolves the board config then pushes', () => {
    mockedGetBoardConfig.mockReturnValue(KILTER_CONFIG);
    const deps = makeDeps();
    openClimbInPlayDrawer({ kind: 'ref', climbUuid: 'c-4', boardType: 'kilter', layoutId: 1, angle: 35 }, deps);
    expect(deps.router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/[climbUuid]',
      params: { climbUuid: 'c-4', boardName: 'kilter', layoutId: '1', sizeId: '10', setIds: '1,20,33', angle: '35' },
    });
  });

  it('kind:ref is a no-op when the board cannot resolve', () => {
    mockedGetBoardConfig.mockReturnValue(null);
    const deps = makeDeps();
    openClimbInPlayDrawer({ kind: 'ref', climbUuid: 'c-5', boardType: 'moonboard', layoutId: 1, angle: 40 }, deps);
    expect(deps.router.push).not.toHaveBeenCalled();
  });
});
