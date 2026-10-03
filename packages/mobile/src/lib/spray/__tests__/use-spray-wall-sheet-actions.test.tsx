// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { DismissAndWaitResult } from '../../../providers/sheet-presentation-provider';
import { useSprayWallSheetActions } from '../use-spray-wall-sheet-actions';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('../../../providers/feature-flags-provider', () => ({ useSprayWallsEnabled: () => flags.enabled }));

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

beforeEach(() => {
  navigation.push.mockClear();
  flags.enabled = true;
});

describe('live spray wall sheet actions', () => {
  it('navigates only after native dismissal settles and ignores duplicate taps', async () => {
    const { dismiss, finish } = deferredDismiss();
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss));
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
    const { result } = renderHook(() => useSprayWallSheetActions(wall, dismiss));
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

  it.each(['board', 'permission', 'visibility', 'reopen', 'off', 'unmount', 'abort'])(
    'cancels stale handoff after %s',
    async (change) => {
      const { dismiss, finish } = deferredDismiss();
      const { result, rerender, unmount } = renderHook(({ board }) => useSprayWallSheetActions(board, dismiss), {
        initialProps: { board: wall },
      });
      act(() => result.current.openShare(wall.uuid));
      if (change === 'board') rerender({ board: { ...wall, uuid: 'wall-2' } });
      if (change === 'permission') rerender({ board: { ...wall, canEdit: false } });
      if (change === 'visibility') rerender({ board: { ...wall, isPublic: false } });
      if (change === 'reopen') act(() => result.current.cancelPendingAction());
      if (change === 'off') {
        flags.enabled = false;
        rerender({ board: wall });
      }
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
    const { result } = renderHook(() => useSprayWallSheetActions({ ...wall, canEdit: false }, dismiss));
    act(() => {
      result.current.openMaintenance(wall.uuid, 'newPhoto');
      result.current.openShare('another-wall');
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('shares an unlisted wall without edit access, but offers no private link', async () => {
    const { dismiss, finish } = deferredDismiss();
    const unlistedWall = { ...wall, canEdit: false, isPublic: false, isUnlisted: true };
    const { result, rerender } = renderHook(({ board }) => useSprayWallSheetActions(board, dismiss), {
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
