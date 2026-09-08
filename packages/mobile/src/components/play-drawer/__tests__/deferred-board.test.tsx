// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controllable requestAnimationFrame: capture every scheduled callback + its id
// so a test can decide whether the deferred frame runs (open commits) or is
// cancelled (sheet closed / unmounted before it fires). A rAF — unlike the old
// InteractionManager gate — can't be starved, so there's no fallback timer.
const rafTasks: Array<{ id: number; run: FrameRequestCallback }> = [];
const cancelledIds = new Set<number>();
let nextRafId = 1;
const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
  const id = nextRafId++;
  rafTasks.push({ id, run: callback });
  return id;
});
const cancelFrame = vi.fn((id: number) => {
  cancelledIds.add(id);
});

type ViewMockProps = { children?: ReactNode; testID?: string; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
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
  layoutReady: true,
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

function flushFrame() {
  act(() => {
    for (const task of rafTasks.splice(0)) {
      if (!cancelledIds.has(task.id)) task.run(performance.now());
    }
  });
}

describe('DeferredBoard', () => {
  beforeEach(() => {
    rafTasks.length = 0;
    cancelledIds.clear();
    nextRafId = 1;
    requestFrame.mockClear();
    cancelFrame.mockClear();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('shows a board-sized placeholder before the deferred frame fires', () => {
    const { container } = render(createElement(DeferredBoard, { ...baseProps, open: true }));

    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('mounts the carousel after the frame fires', () => {
    const { container } = render(createElement(DeferredBoard, { ...baseProps, open: true }));

    flushFrame();

    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeNull();
    const board = container.querySelector('[data-testid="swipe-board"]');
    expect(board?.getAttribute('data-frames')).toBe('p1145r15');
  });

  it('waits for delayed layout, then defers one frame after the measured commit', () => {
    const { container, rerender } = render(
      createElement(DeferredBoard, { ...baseProps, open: true, layoutReady: false }),
    );
    flushFrame();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();

    rerender(createElement(DeferredBoard, { ...baseProps, open: true }));
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();

    flushFrame();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeTruthy();
  });

  it('does not mount when layout arrives after the drawer closes', () => {
    const { container, rerender } = render(
      createElement(DeferredBoard, { ...baseProps, open: true, layoutReady: false }),
    );
    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));
    flushFrame();

    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('keeps the carousel mounted when board geometry changes after opening', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    flushFrame();
    const carousel = container.querySelector('[data-testid="swipe-board"]');

    rerender(
      createElement(DeferredBoard, {
        ...baseProps,
        open: true,
        boardRenderData: { boardWidth: 1200, boardHeight: 1200 },
      }),
    );

    expect(container.querySelector('[data-testid="swipe-board"]')).toBe(carousel);
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('still requires measured layout in screenshot mode', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const { container, rerender } = render(
      createElement(DeferredBoard, { ...baseProps, open: true, layoutReady: false }),
    );
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();

    rerender(createElement(DeferredBoard, { ...baseProps, open: true }));
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeTruthy();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('does NOT re-defer when the climb changes while open (no swipe flash)', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    flushFrame();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeTruthy();

    // Swipe to a different climb: same open transition, new frames. The gate is
    // keyed on `open`, not on the climb, so the board stays mounted.
    rerender(createElement(DeferredBoard, { ...baseProps, open: true, currentFrames: 'p9r12' }));

    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="swipe-board"]')?.getAttribute('data-frames')).toBe('p9r12');
    // No second schedule — the open transition didn't recur.
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending frame and drops the board when the sheet closes before it fires', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    expect(requestFrame).toHaveBeenCalledTimes(1);

    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));

    // The pending frame is cancelled (no setState-after-the-fact leaking a board).
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    // Closed → reset to "not ready": only the cheap placeholder remains.
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
  });

  it('drops a mounted board back to the placeholder when the sheet closes', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    flushFrame();
    expect(container.querySelector('[data-testid="swipe-board"]')).toBeTruthy();

    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));

    expect(container.querySelector('[data-testid="swipe-board"]')).toBeNull();
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
  });

  it('re-shows the placeholder on the next open and schedules a fresh frame', () => {
    const { container, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    flushFrame();
    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));

    // Re-open a different climb: placeholder again, then the new climb's board.
    rerender(createElement(DeferredBoard, { ...baseProps, open: true, currentFrames: 'p77r15' }));
    expect(container.querySelector('[data-testid="deferred-board-placeholder"]')).toBeTruthy();
    expect(requestFrame).toHaveBeenCalledTimes(2);

    flushFrame();
    expect(container.querySelector('[data-testid="swipe-board"]')?.getAttribute('data-frames')).toBe('p77r15');
  });

  it('cancels the pending frame on unmount (no setState-after-unmount)', () => {
    const { unmount } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    expect(requestFrame).toHaveBeenCalledTimes(1);

    unmount();

    expect(cancelFrame).toHaveBeenCalledTimes(1);
  });
});
