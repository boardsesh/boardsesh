import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearBoardArtGeometryCache } from '@boardsesh/board-art-geometry';
import {
  clearSprayWallRegistry,
  ensureSprayWallLoaded,
  getSprayWall,
  getSprayWallLoadState,
  refreshSprayWall,
  registerSprayWall,
  setSprayWallLoader,
  subscribeToSprayWalls,
} from '../spray-wall-registry';
import type { SprayPhotoHold } from '../spray-hold-geometry';
import { resolveClimbRenderBoard } from '../../boards/climb-render-board';
import { getPlaylistRenderBoardTarget } from '../../playlists/playlist-climb-render-board';

const ACTIVE_WALL = 4200;
const OTHER_WALL = 4201;

const HOLDS: SprayPhotoHold[] = [{ id: 7, cx: 100, cy: 200, r: 18 }];

function wallPayload(version: number) {
  return {
    wallUuid: `wall-${version}`,
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: `https://private.example/photo?sig=${version}`,
    photoThumbUrl: null,
    photoExpiresAt: '2026-09-15T12:15:00.000Z',
    holds: HOLDS,
  };
}

beforeEach(() => {
  clearSprayWallRegistry();
  clearBoardArtGeometryCache();
  vi.useRealTimers();
});

afterEach(() => {
  clearSprayWallRegistry();
  clearBoardArtGeometryCache();
});

describe('ensureSprayWallLoaded', () => {
  it('does nothing until a loader is installed', () => {
    ensureSprayWallLoaded(ACTIVE_WALL);
    expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('idle');
  });

  it('fetches a wall once however many rows ask', async () => {
    const loader = vi.fn(async (layoutId: number) => {
      registerSprayWall(layoutId, wallPayload(1));
    });
    setSprayWallLoader(loader);

    ensureSprayWallLoaded(ACTIVE_WALL);
    ensureSprayWallLoaded(ACTIVE_WALL);
    ensureSprayWallLoaded(ACTIVE_WALL);
    await vi.waitFor(() => expect(getSprayWall(ACTIVE_WALL)).not.toBeNull());

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('ready');
  });

  it('never re-fetches a wall it already holds', () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    registerSprayWall(ACTIVE_WALL, wallPayload(1));

    ensureSprayWallLoaded(ACTIVE_WALL);

    expect(loader).not.toHaveBeenCalled();
  });

  it('marks a wall that did not arrive unavailable, and stops asking', async () => {
    const loader = vi.fn(async () => {
      // Resolved without registering: deleted, invisible, or nothing published.
    });
    setSprayWallLoader(loader);

    ensureSprayWallLoaded(ACTIVE_WALL);
    await vi.waitFor(() => expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('unavailable'));

    ensureSprayWallLoaded(ACTIVE_WALL);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('retries a failed load once the cooldown is past', async () => {
    const loader = vi.fn(async () => {
      throw new Error('offline');
    });
    setSprayWallLoader(loader);

    ensureSprayWallLoaded(ACTIVE_WALL);
    await vi.waitFor(() => expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('unavailable'));

    // A sticky failure would mean a board blank until the app is killed.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60_000;
      ensureSprayWallLoaded(ACTIVE_WALL);
    } finally {
      Date.now = realNow;
    }
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('wakes subscribers when a wall lands, so the rows that asked re-render', async () => {
    const listener = vi.fn();
    subscribeToSprayWalls(listener);
    setSprayWallLoader(async (layoutId: number) => {
      registerSprayWall(layoutId, wallPayload(1));
    });

    ensureSprayWallLoaded(ACTIVE_WALL);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });
});

/**
 * The loader is installed from a provider's `useEffect`, and React runs CHILD
 * effects before its parent's — so every row in the first commit resolves its
 * board while the loader is still null. Dropping those asks left a row that never
 * re-renders showing a placeholder for the whole session.
 */
describe('asks that arrive before the loader is installed', () => {
  it('are replayed once the loader lands', async () => {
    // The first commit: rows resolve, nothing can fetch yet.
    ensureSprayWallLoaded(ACTIVE_WALL);
    ensureSprayWallLoaded(OTHER_WALL);
    expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('idle');

    const loader = vi.fn(async (layoutId: number) => {
      registerSprayWall(layoutId, wallPayload(1));
    });
    setSprayWallLoader(loader);

    await vi.waitFor(() => expect(getSprayWall(ACTIVE_WALL)).not.toBeNull());
    await vi.waitFor(() => expect(getSprayWall(OTHER_WALL)).not.toBeNull());
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('are replayed exactly once, however many rows asked', async () => {
    ensureSprayWallLoaded(ACTIVE_WALL);
    ensureSprayWallLoaded(ACTIVE_WALL);
    ensureSprayWallLoaded(ACTIVE_WALL);

    const loader = vi.fn(async (layoutId: number) => {
      registerSprayWall(layoutId, wallPayload(1));
    });
    setSprayWallLoader(loader);

    await vi.waitFor(() => expect(getSprayWall(ACTIVE_WALL)).not.toBeNull());
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('are not replayed a second time when the loader is reinstalled', async () => {
    ensureSprayWallLoaded(ACTIVE_WALL);
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    await vi.waitFor(() => expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('unavailable'));

    // A remount reinstalls the loader; the cooldown, not a replay, decides.
    setSprayWallLoader(loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('wakes render-path subscribers, which ask again on their next render', () => {
    // The per-row resolvers ask from a RENDER, not an effect, so they leave no
    // deferred entry to replay — they need the re-render instead.
    const listener = vi.fn();
    subscribeToSprayWalls(listener);

    setSprayWallLoader(async () => {});

    expect(listener).toHaveBeenCalled();
  });
});

describe('refreshSprayWall', () => {
  it('re-fetches past the cooldown, forcing the cached payload out', async () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    ensureSprayWallLoaded(ACTIVE_WALL);
    await vi.waitFor(() => expect(getSprayWallLoadState(ACTIVE_WALL)).toBe('unavailable'));

    // An expired photo signature: the cooldown must not silence it, and the fetch
    // must be told the cached payload is useless.
    refreshSprayWall(ACTIVE_WALL);
    expect(loader).toHaveBeenLastCalledWith(ACTIVE_WALL, { force: true });
  });
});

/**
 * The four ways a wall reaches a surface without being the active board. Each
 * one must pull the wall in, or it renders a placeholder for the session with no
 * `Board Render Failed` to show for it.
 */
describe('a wall resolved anywhere pulls itself in', () => {
  it('through climb-render-board, when a climb falls back onto its own wall', () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    registerSprayWall(ACTIVE_WALL, wallPayload(1));

    const active = {
      boardName: 'spray',
      layoutId: ACTIVE_WALL,
      sizeId: ACTIVE_WALL,
      setIds: '1',
      angle: 40,
    };
    // A queue item set on the OTHER wall while this one is active.
    const result = resolveClimbRenderBoard(
      { boardType: 'spray', layoutId: OTHER_WALL, angle: 40, frames: 'p9r2' },
      active,
    );

    expect(result?.boardConfig.layoutId).toBe(OTHER_WALL);
    expect(loader).toHaveBeenCalledWith(OTHER_WALL);
  });

  it('through the playlist render-board target', () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    getPlaylistRenderBoardTarget({
      boardName: 'spray',
      layoutId: OTHER_WALL,
      sizeId: OTHER_WALL,
      setIds: '1',
      angle: 40,
    });

    expect(loader).toHaveBeenCalledWith(OTHER_WALL);
  });

  it('asks for nothing on a catalogue board', () => {
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    getPlaylistRenderBoardTarget({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '24,25', angle: 40 });
    resolveClimbRenderBoard({ boardType: 'kilter', layoutId: 1, angle: 40, frames: 'p1r12' }, null);

    expect(loader).not.toHaveBeenCalled();
  });
});
