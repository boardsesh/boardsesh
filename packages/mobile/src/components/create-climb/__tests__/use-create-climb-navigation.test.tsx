// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { DismissAndWaitResult } from '../../../providers/sheet-presentation-provider';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const sentry = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('../../../lib/sentry', () => ({ captureToSentry: sentry.capture }));

import { useCreateClimbNavigation, type DismissSurfaceAndWait } from '../use-create-climb-navigation';

const climb = {
  uuid: 'climb-1',
  name: 'Sloper Traverse',
  frames: 'p1129r15p1130r12',
  description: 'Start matched on the jug',
} as unknown as Climb;

const board = { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27', angle: 40 };

function deferredDismiss() {
  let resolvePromise: (result: DismissAndWaitResult) => void = () => {};
  const promise = new Promise<DismissAndWaitResult>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

beforeEach(() => {
  router.push.mockReset();
  sentry.capture.mockClear();
});

describe('useCreateClimbNavigation serialized handoff', () => {
  it.each([{ characteristics: [] }, { characteristics: ['campus', 'no_kickboard'] }, { characteristics: null }])(
    'carries source rules and physical size into a Woods remix: $characteristics',
    ({ characteristics }) => {
      const { result } = renderHook(() => useCreateClimbNavigation());
      const source = {
        ...climb,
        boardType: 'woods',
        layoutId: 1,
        frames: 'p0r4p1r3',
        compatibleSizeIds: [1],
        characteristics,
      };
      result.current.openRemix(source, { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 });
      const params = router.push.mock.calls[0][0].params;
      expect(params.sizeId).toBe('1');
      expect(params.forkCharacteristics).toBe(characteristics ? JSON.stringify(characteristics) : undefined);
    },
  );

  it('claims one action before overlay dismissal, then waits source → player → push', async () => {
    const sourceDeferred = deferredDismiss();
    const playerDeferred = deferredDismiss();
    const dismissSourceSheet = vi.fn(() => sourceDeferred.promise);
    const dismissPlayerAndWait = vi.fn(() => playerDeferred.promise);
    const dismissOverlay = vi.fn();
    const { result } = renderHook(() => useCreateClimbNavigation({ dismissSourceSheet, dismissPlayerAndWait }));

    result.current.openRemix(climb, board, dismissOverlay);
    result.current.openRemix(climb, board, dismissOverlay); // overlay is still hit-testable

    expect(dismissOverlay).toHaveBeenCalledTimes(1);
    expect(dismissSourceSheet).toHaveBeenCalledTimes(1);
    expect(dismissOverlay.mock.invocationCallOrder[0]).toBeLessThan(dismissSourceSheet.mock.invocationCallOrder[0]);
    expect(dismissPlayerAndWait).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    await act(async () => sourceDeferred.resolve({ status: 'dismissed' }));
    expect(dismissPlayerAndWait).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();

    await act(async () => playerDeferred.resolve({ status: 'dismissed' }));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('stops when source-sheet teardown aborts the wait', async () => {
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result } = renderHook(() =>
      useCreateClimbNavigation({
        dismissSourceSheet: async () => ({ status: 'aborted' }),
        dismissPlayerAndWait,
      }),
    );

    result.current.openEdit(climb, board);
    await act(async () => {});

    expect(dismissPlayerAndWait).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('stops when the player route unmount aborts its transition wait', async () => {
    const { result } = renderHook(() =>
      useCreateClimbNavigation({ dismissPlayerAndWait: async () => ({ status: 'aborted' }) }),
    );

    result.current.openRemix(climb, board);
    await act(async () => {});

    expect(router.push).not.toHaveBeenCalled();
  });

  it('pushes immediately when no native source or player callback was injected (including iPad panes)', () => {
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openRemix(climb, board);

    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('accepts a fresh action after its owning menu unmounts and mounts again', () => {
    const firstMenu = renderHook(() => useCreateClimbNavigation());
    firstMenu.result.current.openRemix(climb, board);
    expect(router.push).toHaveBeenCalledTimes(1);
    firstMenu.unmount();

    const reopenedMenu = renderHook(() => useCreateClimbNavigation());
    reopenedMenu.result.current.openRemix(climb, board);

    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it('captures a failed route push while preserving the one-action claim until re-open', async () => {
    const navigationError = new Error('route transition failed');
    router.push.mockImplementationOnce(() => {
      throw navigationError;
    });
    const { result } = renderHook(() => useCreateClimbNavigation());

    result.current.openRemix(climb, board);
    await act(async () => {});

    expect(sentry.capture).toHaveBeenCalledWith(navigationError, {
      level: 'error',
      tags: { source: 'create-climb-handoff' },
    });

    result.current.openRemix(climb, board);
    expect(router.push).toHaveBeenCalledTimes(1);

    result.current.resetActionGuard();
    result.current.openRemix(climb, board);
    expect(router.push).toHaveBeenCalledTimes(2);
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
  it('keeps openRemix / openEdit stable while reading the latest injected waiter', async () => {
    const firstWaiter = vi.fn(async () => ({ status: 'dismissed' as const }));
    const secondWaiter = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result, rerender } = renderHook(
      ({ dismissSourceSheet }: { dismissSourceSheet?: DismissSurfaceAndWait }) =>
        useCreateClimbNavigation({ dismissSourceSheet }),
      { initialProps: { dismissSourceSheet: firstWaiter } },
    );
    const firstCallbacks = { openRemix: result.current.openRemix, openEdit: result.current.openEdit };

    rerender({ dismissSourceSheet: secondWaiter });
    result.current.openRemix(climb, board);
    await act(async () => {});

    expect(result.current.openRemix).toBe(firstCallbacks.openRemix);
    expect(result.current.openEdit).toBe(firstCallbacks.openEdit);
    expect(firstWaiter).not.toHaveBeenCalled();
    expect(secondWaiter).toHaveBeenCalledTimes(1);
  });
});
