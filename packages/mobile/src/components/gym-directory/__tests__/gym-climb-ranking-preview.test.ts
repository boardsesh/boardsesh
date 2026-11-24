import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  GET_SPRAY_CLIMB,
  GET_SPRAY_WALL_BY_LAYOUT,
  GET_SPRAY_WALL_RENDER_DATA,
  GYM_REPORTING_RECEIPT_MS,
} from '@boardsesh/graphql';
import type { GymClimbRankingTarget } from '@boardsesh/shared-schema';
import { retireGymClimbRankings } from '../../../lib/privacy/privacy-cache';
import { createGymClimbPreviewAuthorization, readGymClimbPreview } from '../gym-climb-ranking-preview';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  authEpoch: 1,
  authListeners: new Set<() => void>(),
}));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => mocks.authEpoch,
  isAuthCredentialGenerationCurrent: (epoch: number) => epoch === mocks.authEpoch,
  subscribeAuthCredentialGenerationChanges: (listener: () => void) => {
    mocks.authListeners.add(listener);
    return () => {
      mocks.authListeners.delete(listener);
    };
  },
}));
vi.mock('../../../lib/local-user-id', () => ({ readLocalUserId: async () => 'staff' }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  photoDimensions: ({ photo }: { photo: { width: number; height: number } }) => ({
    width: photo.width,
    height: photo.height,
  }),
  toCanonicalHolds: ({ holds }: { holds: unknown[] }) => holds,
}));

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  mocks.request.mockReset();
  mocks.authListeners.clear();
  mocks.authEpoch = 1;
});

describe('native ranking inspection authorization', () => {
  it.each(['deadline', 'credential', 'local privacy', 'same-tick offline recovery', 'app background'] as const)(
    'retires once after %s without treating the Analytics navigation blur as app focus loss',
    async (change) => {
      vi.useFakeTimers();
      const guard = createGymClimbPreviewAuthorization(Date.now() + GYM_REPORTING_RECEIPT_MS, 1);
      const retired = vi.fn();
      const unsubscribe = guard.subscribe(retired);
      try {
        await vi.advanceTimersByTimeAsync(GYM_REPORTING_RECEIPT_MS - 1);
        expect(guard.isCurrent()).toBe(true);
        expect(retired).not.toHaveBeenCalled();
        switch (change) {
          case 'deadline':
            await vi.advanceTimersByTimeAsync(1);
            break;
          case 'credential':
            mocks.authEpoch += 1;
            for (const listener of mocks.authListeners) listener();
            break;
          case 'local privacy':
            await retireGymClimbRankings(new QueryClient());
            break;
          case 'same-tick offline recovery':
            onlineManager.setOnline(false);
            onlineManager.setOnline(true);
            break;
          case 'app background':
            focusManager.setFocused(false);
            focusManager.setFocused(true);
            break;
        }
        expect(guard.isCurrent()).toBe(false);
        expect(retired).toHaveBeenCalledOnce();
      } finally {
        unsubscribe();
        guard.retire();
      }
    },
  );
});

describe('native private spray inspection assets', () => {
  const target: GymClimbRankingTarget = {
    boardType: 'spray',
    logicalBoardUuid: 'verified-wall',
    boardSlug: 'unlisted-slug',
    name: 'Local climb',
    layoutId: 540,
    sizeId: 540,
    setIds: '541',
    angle: 40,
    isMirror: false,
    climbUuid: 'verified-climb',
    referenceDifficulty: null,
    shareable: false,
  };
  const wall = { uuid: target.logicalBoardUuid, currentVersion: { number: 4 }, board: { angle: 40 } };
  const render = {
    wall,
    versionNumber: 4,
    homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    holds: [{ id: 1, cx: 70, cy: 80, r: 5 }],
    photo: { url: 'https://private.invalid/fresh', width: 400, height: 300 },
  };
  const climb = { frames: 'p1r12', angle: 40, uuid: target.climbUuid };

  it('uses fresh independent wall access, exact current render geometry and no link capability', async () => {
    mocks.request
      .mockResolvedValueOnce({ climb })
      .mockResolvedValueOnce({ sprayWallByLayout: wall })
      .mockResolvedValueOnce({ sprayWallRenderData: render });
    const signal = new AbortController().signal;
    const resolved = await readGymClimbPreview('staff', target, signal);
    expect(resolved.config).toEqual({ boardName: 'spray', layoutId: 540, sizeId: 540, setIds: '541', angle: 40 });
    expect(resolved.sprayArt).toMatchObject({ uri: render.photo.url, width: 400, height: 300 });
    expect(mocks.request.mock.calls.map(([request]) => [request.document, request.variables])).toEqual([
      [GET_SPRAY_CLIMB, { ...resolved.config, climbUuid: 'verified-climb' }],
      [GET_SPRAY_WALL_BY_LAYOUT, { layoutId: 540 }],
      [GET_SPRAY_WALL_RENDER_DATA, { uuid: 'verified-wall', version: 4 }],
    ]);
  });

  it('rejects render data superseded between the authenticated wall and photo reads', async () => {
    mocks.request
      .mockResolvedValueOnce({ climb })
      .mockResolvedValueOnce({ sprayWallByLayout: wall })
      .mockResolvedValueOnce({
        sprayWallRenderData: { ...render, wall: { ...wall, currentVersion: { number: 5 } } },
      });
    await expect(readGymClimbPreview('staff', target, new AbortController().signal)).rejects.toThrow();
  });
});
