// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';

const ctrl = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as readonly string[] }));
const router = vi.hoisted(() => ({ push: vi.fn(), dismiss: vi.fn() }));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useSegments: () => ctrl.segments,
}));

import { useCreateClimbNavigation } from '../use-create-climb-navigation';

const climb = {
  uuid: 'climb-1',
  name: 'Sloper Traverse',
  frames: 'p1129r15p1130r12',
  description: 'Start matched on the jug',
} as unknown as Climb;

const board = { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27', angle: 40 };

beforeEach(() => {
  ctrl.segments = ['(tabs)', 'climbs'];
  router.push.mockClear();
  router.dismiss.mockClear();
});

describe('useCreateClimbNavigation player dismiss', () => {
  // /play is a transparentModal in the ROOT stack; /(tabs)/climbs/create is a
  // transparentModal in the CLIMBS-TAB stack, which is mounted BENEATH it. Pushing
  // create without dismissing the player stacks it under the live player.
  it('dismisses the player before pushing create when /play is focused', () => {
    ctrl.segments = ['play'];
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openRemix(climb, board);

    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.dismiss.mock.invocationCallOrder[0]).toBeLessThan(router.push.mock.invocationCallOrder[0]);
  });

  it('pushes without dismissing from the climbs list', () => {
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openRemix(climb, board);

    expect(router.dismiss).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  // The iPad regular-width layout hosts the player in the detail pane, so the focused
  // route is still a tabs route and there is no modal to pop.
  it('pushes without dismissing from a pushed climbs sub-route (iPad pane player)', () => {
    ctrl.segments = ['(tabs)', 'climbs', '[climbUuid]'];
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openEdit(climb, board);

    expect(router.dismiss).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});

describe('useCreateClimbNavigation params', () => {
  it('openRemix carries the fork seed plus stringified board params', () => {
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openRemix(climb, board);

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        forkFrames: 'p1129r15p1130r12',
        forkName: 'Sloper Traverse',
        forkDescription: 'Start matched on the jug',
        boardName: 'kilter',
        layoutId: '8',
        sizeId: '17',
        setIds: '26,27',
        angle: '40',
      },
    });
  });

  it('openRemix sends an empty string for a description-less climb', () => {
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openRemix({ ...climb, description: null } as unknown as Climb, board);

    expect(router.push.mock.calls[0][0].params.forkDescription).toBe('');
  });

  it('openEdit carries the climb uuid and no fork seed', () => {
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openEdit(climb, board);

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        editClimbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: '8',
        sizeId: '17',
        setIds: '26,27',
        angle: '40',
      },
    });
  });
});

describe('useCreateClimbNavigation callback stability', () => {
  // `useSegments()` returns a fresh array on every navigation. If it were a dep rather
  // than a ref read, these callbacks would change identity on each one and rebuild
  // `useClimbActions`' memoised action list.
  it('keeps openRemix / openEdit stable across a segments change', () => {
    const { result, rerender } = renderHook(() => useCreateClimbNavigation());
    const first = { openRemix: result.current.openRemix, openEdit: result.current.openEdit };

    ctrl.segments = ['play'];
    rerender();

    expect(result.current.openRemix).toBe(first.openRemix);
    expect(result.current.openEdit).toBe(first.openEdit);
  });

  it('still reads the CURRENT segments through the stable callback', () => {
    const { result, rerender } = renderHook(() => useCreateClimbNavigation());
    const openRemix = result.current.openRemix;

    ctrl.segments = ['play'];
    rerender();
    openRemix(climb, board);

    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });
});
