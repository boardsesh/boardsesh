// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controllable InteractionManager: capture every scheduled callback + its
// cancel so a test can decide whether the deferred work runs (open settles) or
// is cancelled (sheet closed / unmounted before it fires). Hoisted so the
// (top-of-file-hoisted) vi.mock factory below can close over it.
const { scheduledTasks, runAfterInteractions } = vi.hoisted(() => {
  const tasks: Array<{ run: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  return {
    scheduledTasks: tasks,
    runAfterInteractions: vi.fn((callback: () => void) => {
      const cancel = vi.fn();
      tasks.push({ run: callback, cancel });
      return { cancel };
    }),
  };
});

type ViewMockProps = { children?: ReactNode; testID?: string; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  InteractionManager: { runAfterInteractions },
}));

// The carousel is the expensive thing we're deferring — stand it in with a
// cheap marker that echoes the climb frames so we can assert which climb shows.
vi.mock('../SwipeBoardCarousel', () => ({
  SwipeBoardCarousel: ({ currentFrames }: { currentFrames: string }) =>
    createElement('div', { 'data-testid': 'swipe-board', 'data-frames': currentFrames }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8E8E93' } }));

import { DeferredBoard } from '../DeferredBoard';

const baseProps = {
  boardName: 'kilter' as const,
  boardRenderData: { boardWidth: 1080, boardHeight: 1920 },
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  currentFrames: 'p1145r15',
  nextFrames: null,
  prevFrames: null,
  mirrored: false,
  canSwipeNext: true,
  canSwipePrevious: false,
  onSwipeNext: vi.fn(),
  onSwipePrevious: vi.fn(),
};

function settleAllInteractions() {
  act(() => {
    for (const task of scheduledTasks.splice(0)) {
      task.run();
    }
  });
}

describe('DeferredBoard', () => {
  beforeEach(() => {
    scheduledTasks.length = 0;
    runAfterInteractions.mockClear();
  });

  it('shows a board-sized placeholder before the present animation settles', () => {
    const { container } = render(createElement(DeferredBoard, { ...baseProps, open: true }));

    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(runAfterInteractions).toHaveBeenCalledTimes(1);
  });

  it('mounts the carousel after interactions settle', () => {
    const { container } = render(createElement(DeferredBoard, { ...baseProps, open: true }));

    settleAllInteractions();

    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeNull();
    const board = container.querySelector('[data-testid="swipe-board"]');
    expect(board?.getAttribute('data-frames')).toBe('p1145r15');
  });

  it('does NOT re-show the placeholder when the climb changes while open (no swipe flash)', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    settleAllInteractions();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeTruthy();

    // Swipe to a different climb: same open transition, new frames. The gate is
    // keyed on `open`, not on the climb, so the board stays mounted.
    rerender(createElement(DeferredBoard, { ...baseProps, open: true, currentFrames: 'p9r12' }));

    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="swipe-board"]')?.getAttribute('data-frames')).toBe('p9r12');
    // No second schedule — the open transition didn't recur.
    expect(runAfterInteractions).toHaveBeenCalledTimes(1);
  });

  it('cancels the scheduled mount and drops the board when the sheet closes before it fires', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    const [scheduled] = scheduledTasks;

    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));

    // The pending mount is cancelled (no setState-after-the-fact leaking a board).
    expect(scheduled.cancel).toHaveBeenCalledTimes(1);
    // Closed → reset to "not ready": the carousel is gone, only the cheap
    // placeholder remains (the parent unmounts the whole block once it clears
    // the displayed climb on dismiss).
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
  });

  it('drops a mounted board back to the placeholder when the sheet closes (no stale board on reopen)', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    settleAllInteractions();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeTruthy();

    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));

    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
  });

  it('re-shows the placeholder on the next open and schedules a fresh mount', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    settleAllInteractions();
    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));

    // Re-open a different climb: placeholder again, then the new climb's board.
    rerender(createElement(DeferredBoard, { ...baseProps, open: true, currentFrames: 'p77r15' }));
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
    expect(runAfterInteractions).toHaveBeenCalledTimes(2);

    settleAllInteractions();
    expect(container.querySelector('[data-testid="swipe-board"]')?.getAttribute('data-frames')).toBe('p77r15');
  });

  it('cancels the scheduled mount on unmount (no setState-after-unmount)', () => {
    const { unmount } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    const [scheduled] = scheduledTasks;

    unmount();

    expect(scheduled.cancel).toHaveBeenCalledTimes(1);
  });
});
