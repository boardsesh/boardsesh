// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({
  offline: false,
  pendingTick: false,
  hasQueuedTickForClimb: vi.fn(async (_climbUuid: string) => false),
  confirmed: true,
  confirm: vi.fn(async (_options: unknown) => true),
  showToast: vi.fn(),
  mutateAsync: vi.fn(async (_variables: unknown): Promise<boolean> => true),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/graphql/hooks/use-delete-climb', () => ({
  useDeleteClimb: () => ({
    mutateWithReceipt: async (variables: unknown) => ({
      result: await ctrl.mutateAsync(variables),
      assertCurrent: () => {},
    }),
  }),
}));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: ctrl.offline }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => ctrl.confirm }));
vi.mock('../../../offline/pending-tick', () => ({ hasQueuedTickForClimb: ctrl.hasQueuedTickForClimb }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: ctrl.showToast }) }));

import { useDeleteClimbAction } from '../use-delete-climb-action';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';

const climb = { uuid: 'climb-1' };

function codedError(code: string) {
  return Object.assign(new Error('refused'), { extensions: { code } });
}

beforeEach(() => {
  ctrl.offline = false;
  ctrl.pendingTick = false;
  ctrl.hasQueuedTickForClimb.mockReset();
  ctrl.hasQueuedTickForClimb.mockImplementation(async () => ctrl.pendingTick);
  ctrl.confirm.mockReset();
  ctrl.confirm.mockImplementation(async () => ctrl.confirmed);
  ctrl.confirmed = true;
  ctrl.showToast.mockReset();
  ctrl.mutateAsync.mockReset();
  ctrl.mutateAsync.mockImplementation(async () => true);
});

describe('useDeleteClimbAction (#5960)', () => {
  it('refuses offline with its own line, before any confirm or request', async () => {
    ctrl.offline = true;
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useDeleteClimbAction());

    await act(() => result.current(climb, 'spray', onDeleted));

    expect(ctrl.showToast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.offline', 'error');
    expect(ctrl.confirm).not.toHaveBeenCalled();
    expect(ctrl.mutateAsync).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('refuses while this phone has a send on the climb waiting to sync, before any confirm or request', async () => {
    ctrl.pendingTick = true;
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useDeleteClimbAction());

    await act(() => result.current(climb, 'spray', onDeleted));

    expect(ctrl.hasQueuedTickForClimb).toHaveBeenCalledWith('climb-1');
    expect(ctrl.showToast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.pendingTick', 'error');
    expect(ctrl.confirm).not.toHaveBeenCalled();
    expect(ctrl.mutateAsync).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('asks first, as a destructive confirm, and sends nothing when the setter keeps it', async () => {
    ctrl.confirmed = false;
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useDeleteClimbAction());

    await act(() => result.current(climb, 'spray', onDeleted));

    expect(ctrl.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'mobile.climbActions.deleteClimb.title', destructive: true }),
    );
    expect(ctrl.mutateAsync).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('deletes on confirm, says so, then runs the after-delete callback', async () => {
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useDeleteClimbAction());

    await act(() => result.current(climb, 'spray', onDeleted));

    expect(ctrl.mutateAsync).toHaveBeenCalledWith({ uuid: 'climb-1', boardType: 'spray' });
    expect(ctrl.showToast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.success', 'success');
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CLIMB_HAS_TICKS', 'mobile.climbActions.deleteClimb.hasTicks'],
    ['CLIMB_NOT_FOUND', 'mobile.climbActions.deleteClimb.notFound'],
    ['CLIMB_DELETE_NOT_ALLOWED', 'mobile.climbActions.deleteClimb.notAllowed'],
    ['SPRAY_WALL_ARCHIVED', 'mobile.climbActions.deleteClimb.archived'],
    ['INTERNAL_SERVER_ERROR', 'mobile.climbActions.deleteClimb.error'],
  ])('answers %s with %s and keeps the drawer open', async (code, message) => {
    ctrl.mutateAsync.mockRejectedValueOnce(codedError(code));
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useDeleteClimbAction());

    await act(() => result.current(climb, 'spray', onDeleted));

    expect(ctrl.showToast).toHaveBeenCalledWith(message, 'error');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('reads the code off a raw GraphQL response error too', async () => {
    ctrl.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('refused'), {
        response: { errors: [{ message: 'x', extensions: { code: 'CLIMB_HAS_TICKS' } }] },
      }),
    );
    const { result } = renderHook(() => useDeleteClimbAction());

    await act(() => result.current(climb, 'spray'));

    expect(ctrl.showToast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.hasTicks', 'error');
  });

  it('ignores a second tap while the first is still asking', async () => {
    let answer!: (value: boolean) => void;
    ctrl.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const { result } = renderHook(() => useDeleteClimbAction());

    let first!: Promise<void>;
    await act(async () => {
      first = result.current(climb, 'spray');
      await result.current(climb, 'spray');
    });
    await act(async () => {
      answer(true);
      await first;
    });

    expect(ctrl.confirm).toHaveBeenCalledTimes(1);
    expect(ctrl.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('asks again for a different climb while the first is still asking', async () => {
    const answers: ((value: boolean) => void)[] = [];
    ctrl.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { result } = renderHook(() => useDeleteClimbAction());

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current(climb, 'spray');
      second = result.current({ uuid: 'climb-2' }, 'spray');
      await result.current(climb, 'spray');
    });
    await act(async () => {
      answers.forEach((answer) => answer(true));
      await Promise.all([first, second]);
    });

    expect(ctrl.confirm).toHaveBeenCalledTimes(2);
    expect(ctrl.mutateAsync.mock.calls.map(([variables]) => variables)).toEqual([
      { uuid: 'climb-1', boardType: 'spray' },
      { uuid: 'climb-2', boardType: 'spray' },
    ]);
  });

  it('on native, finishes and says so after the player unmounts, without closing it again', async () => {
    let answer!: (value: boolean) => void;
    ctrl.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const onDeleted = vi.fn();
    const { result, unmount } = renderHook(() => useDeleteClimbAction());

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current(climb, 'spray', onDeleted);
    });
    unmount();
    await act(async () => {
      answer(true);
      await pending;
    });

    expect(ctrl.mutateAsync).toHaveBeenCalledOnce();
    expect(ctrl.showToast).toHaveBeenCalledExactlyOnceWith('mobile.climbActions.deleteClimb.success', 'success');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('on native, sends nothing for a confirm answered after sign-out', async () => {
    let answer!: (value: boolean) => void;
    ctrl.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const { result } = renderHook(() => useDeleteClimbAction());

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current(climb, 'spray');
    });
    invalidateCredentialSnapshots();
    await act(async () => {
      answer(true);
      await pending;
    });

    expect(ctrl.mutateAsync).not.toHaveBeenCalled();
    expect(ctrl.showToast).not.toHaveBeenCalled();
  });
});

// The native host keeps its existing credential policy; the real action hook
// still owns layout cleanup and caller cancellation.
vi.mock('../../../lib/graphql/use-http-query-scope', () => {
  const scope = { scoped: false, scope: undefined, assertView: () => {}, isReady: () => true };
  return { useHttpQueryScope: () => scope };
});
