// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Board = Pick<UserBoard, 'angle' | 'isAngleAdjustable' | 'boardType' | 'layoutId'>;

const ctrl = vi.hoisted(() => ({ board: null as Board | null, setActiveBoard: vi.fn() }));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: ctrl.board }),
  useSetActiveBoard: () => ctrl.setActiveBoard,
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));

import { useMaterialAngleControl } from '../use-material-angle-control';

const adjustableBoard: Board = { angle: 40, isAngleAdjustable: true, boardType: 'kilter', layoutId: 1 };

describe('useMaterialAngleControl', () => {
  beforeEach(() => {
    ctrl.board = null;
    ctrl.setActiveBoard.mockReset();
    haptics.light.mockReset();
  });

  it('reports canAdjust for an adjustable board with an angle', () => {
    ctrl.board = adjustableBoard;
    const { result } = renderHook(() => useMaterialAngleControl());
    expect(result.current.canAdjust).toBe(true);
  });

  it('is not adjustable for a fixed-angle board', () => {
    ctrl.board = { ...adjustableBoard, isAngleAdjustable: false };
    const { result } = renderHook(() => useMaterialAngleControl());
    expect(result.current.canAdjust).toBe(false);
  });

  it('is not adjustable when the angle is missing', () => {
    ctrl.board = { ...adjustableBoard, angle: null as unknown as number };
    const { result } = renderHook(() => useMaterialAngleControl());
    expect(result.current.canAdjust).toBe(false);
  });

  it('opens the sheet with a haptic', () => {
    ctrl.board = adjustableBoard;
    const { result } = renderHook(() => useMaterialAngleControl());
    act(() => result.current.open());
    expect(result.current.visible).toBe(true);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('does not open (or fire a haptic) for a fixed-angle board', () => {
    ctrl.board = { ...adjustableBoard, isAngleAdjustable: false };
    const { result } = renderHook(() => useMaterialAngleControl());
    act(() => result.current.open());
    expect(result.current.visible).toBe(false);
    expect(haptics.light).not.toHaveBeenCalled();
  });

  it('closes the sheet', () => {
    ctrl.board = adjustableBoard;
    const { result } = renderHook(() => useMaterialAngleControl());
    act(() => result.current.open());
    act(() => result.current.close());
    expect(result.current.visible).toBe(false);
  });

  it('persists a new angle via setActiveBoard', () => {
    ctrl.board = adjustableBoard;
    const { result } = renderHook(() => useMaterialAngleControl());
    act(() => result.current.change(45));
    expect(ctrl.setActiveBoard).toHaveBeenCalledWith({ ...adjustableBoard, angle: 45 });
  });

  it('ignores a no-op change to the current angle', () => {
    ctrl.board = adjustableBoard;
    const { result } = renderHook(() => useMaterialAngleControl());
    act(() => result.current.change(40));
    expect(ctrl.setActiveBoard).not.toHaveBeenCalled();
  });

  it('ignores a change for a fixed-angle board', () => {
    ctrl.board = { ...adjustableBoard, isAngleAdjustable: false };
    const { result } = renderHook(() => useMaterialAngleControl());
    act(() => result.current.change(45));
    expect(ctrl.setActiveBoard).not.toHaveBeenCalled();
  });
});
