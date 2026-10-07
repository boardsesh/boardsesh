// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { DismissAndWaitResult } from '../../../providers/sheet-presentation-provider';
import { useSprayWallSheetActions } from '../use-spray-wall-sheet-actions';
import {
  clearSprayWallRegistry,
  LIVE_SPRAY_WALL_ARCHIVE_STATE,
  registerSprayWall,
  type SprayWallArchiveState,
} from '../spray-wall-registry';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const confirmReset = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../confirm-spray-wall-reset', () => ({ confirmSprayWallReset: confirmReset }));
const trackSpray = vi.hoisted(() => vi.fn());
vi.mock('../spray-telemetry', () => ({ trackSprayEvent: trackSpray }));
const wall: UserBoard = {
  uuid: 'wall-1',
  slug: 'garage',
  name: 'Garage',
  ownerId: 'owner-1',
  boardType: 'spray',
  layoutId: 12,
  sizeId: 12,
  setIds: '12',
  angle: 30,
  canEdit: true,
  isPublic: true,
  isUnlisted: false,
  isOwned: true,
  isFollowedByMe: true,
  hideLocation: false,
  isAngleAdjustable: false,
  createdAt: '2026-01-01',
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
  commentCount: 0,
};

function deferredDismiss() {
  let finish!: (result: DismissAndWaitResult) => void;
  const promise = new Promise<DismissAndWaitResult>((resolve) => {
    finish = resolve;
  });
  return { dismiss: vi.fn(() => promise), finish };
}

function registerWall(archive: SprayWallArchiveState = LIVE_SPRAY_WALL_ARCHIVE_STATE) {
  registerSprayWall(wall.layoutId, {
    wallUuid: wall.uuid,
    angle: wall.angle,
    version: 1,
    versionId: 1,
    photoWidth: 100,
    photoHeight: 100,
    photoUrl: 'https://example.invalid/wall.jpg',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [],
    archive,
  });
}

beforeEach(() => {
  navigation.push.mockClear();
  confirmReset.mockReset();
  confirmReset.mockResolvedValue(true);
  trackSpray.mockClear();
  clearSprayWallRegistry();
  registerWall();
});

describe('live spray wall sheet actions', () => {
  it('keeps a pending handoff when the same wall rerenders', async () => {
    const { dismiss, finish } = deferredDismiss();
    const { result, rerender } = renderHook(() => useSprayWallSheetActions(wall, dismiss, 'owner-1'));
    act(() => result.current.openMaintenance(wall.uuid, 'editHolds'));
    expect(dismiss).toHaveBeenCalledTimes(1);
    rerender();
    await act(async () => finish({ status: 'dismissed' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/boards/spray/holds?wallUuid=wall-1');
  });

  it('navigates only after native dismissal settles and ignores duplicate taps', async () => {
    const { dismiss, finish } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss, 'owner-1'));
    act(() => {
      result.current.openMaintenance(wall.uuid, 'editHolds');
      result.current.openMaintenance(wall.uuid, 'editHolds');
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => {
      finish({ status: 'dismissed' });
    });
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/boards/spray/holds?wallUuid=wall-1');
  });

  it('opens a stable share snapshot after dismissal and retains it through closing', async () => {
    const { dismiss, finish } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss, 'owner-1'));
    act(() => result.current.openShare(wall.uuid));
    expect(result.current.shareSnapshot).toBeNull();
    await act(async () => {
      finish({ status: 'dismissed' });
    });
    const snapshot = result.current.shareSnapshot;
    expect(snapshot).toMatchObject({ wallUuid: wall.uuid, wallName: wall.name, visibility: 'public' });
    expect(result.current.shareVisible).toBe(true);
    act(() => result.current.closeShare());
    expect(result.current.shareVisible).toBe(false);
    expect(result.current.shareSnapshot).toBe(snapshot);
    act(() => result.current.clearShareSnapshot());
    expect(result.current.shareSnapshot).toBeNull();
  });

  it.each(['board', 'permission', 'visibility', 'reopen', 'unmount', 'abort'])(
    'cancels stale handoff after %s',
    async (change) => {
      const { dismiss, finish } = deferredDismiss();
      const { result, rerender, unmount } = renderHook(
        ({ board }) => useSprayWallSheetActions(board, dismiss, 'owner-1'),
        {
          initialProps: { board: wall },
        },
      );
      act(() => result.current.openShare(wall.uuid));
      if (change === 'board') rerender({ board: { ...wall, uuid: 'wall-2' } });
      if (change === 'permission') rerender({ board: { ...wall, canEdit: false } });
      if (change === 'visibility') rerender({ board: { ...wall, isPublic: false } });
      if (change === 'reopen') act(() => result.current.cancelPendingAction());
      if (change === 'unmount') unmount();
      await act(async () => {
        finish({ status: change === 'abort' ? 'aborted' : 'dismissed' });
      });
      expect(navigation.push).not.toHaveBeenCalled();
      expect(result.current.shareSnapshot).toBeNull();
    },
  );

  it('rechecks edit permissions and wall identity before leaving the sheet', () => {
    const { dismiss } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions({ ...wall, canEdit: false }, dismiss, 'someone'));
    act(() => {
      result.current.openMaintenance(wall.uuid, 'editHolds');
      result.current.openMaintenance(wall.uuid, 'resetWall');
      result.current.openShare('another-wall');
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(confirmReset).not.toHaveBeenCalled();
  });

  // Counted once per confirm tap, here, with where the owner confirmed it.
  it('asks before a reset, then opens the wizard on that wall', async () => {
    const { dismiss, finish } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss, 'owner-1'));
    await act(async () => {
      result.current.openMaintenance(wall.uuid, 'resetWall');
    });
    expect(confirmReset).toHaveBeenCalledWith({
      title: 'sprayResetConfirm.title',
      body: 'sprayResetConfirm.body',
      start: 'sprayResetConfirm.start',
      cancel: 'sprayResetConfirm.cancel',
    });
    expect(trackSpray).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ properties: { source: 'board_sheet' } }),
    );
    await act(async () => finish({ status: 'dismissed' }));
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/boards/spray/new?resetOf=wall-1');
  });

  it('leaves the sheet up and records nothing when the owner says "Not now"', async () => {
    confirmReset.mockResolvedValue(false);
    const { dismiss } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss, 'owner-1'));
    await act(async () => {
      result.current.openMaintenance(wall.uuid, 'resetWall');
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(trackSpray).not.toHaveBeenCalled();
    // And the next tap is not swallowed by a pending action.
    confirmReset.mockResolvedValue(true);
    await act(async () => {
      result.current.openMaintenance(wall.uuid, 'resetWall');
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('opens nothing on a wall archived since the sheet rendered', async () => {
    clearSprayWallRegistry();
    registerWall({
      ...LIVE_SPRAY_WALL_ARCHIVE_STATE,
      archivedAt: '2026-10-01T09:00:00.000Z',
    });
    const { dismiss } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss, 'owner-1'));
    await act(async () => {
      result.current.openMaintenance(wall.uuid, 'editHolds');
      result.current.openMaintenance(wall.uuid, 'resetWall');
    });
    expect(confirmReset).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('shares an unlisted wall without edit access, but offers no private link', async () => {
    const { dismiss, finish } = deferredDismiss();
    const unlistedWall = { ...wall, canEdit: false, isPublic: false, isUnlisted: true };
    const { result, rerender } = renderHook(({ board }) => useSprayWallSheetActions(board, dismiss, 'owner-1'), {
      initialProps: { board: unlistedWall },
    });
    act(() => result.current.openShare(wall.uuid));
    await act(async () => {
      finish({ status: 'dismissed' });
    });
    expect(result.current.shareSnapshot?.url).toContain(`wall=${wall.uuid}`);
    expect(result.current.shareSnapshot?.visibility).toBe('unlisted');
    rerender({ board: { ...unlistedWall, isUnlisted: false } });
    dismiss.mockClear();
    act(() => result.current.openShare(wall.uuid));
    expect(dismiss).not.toHaveBeenCalled();
  });
});
