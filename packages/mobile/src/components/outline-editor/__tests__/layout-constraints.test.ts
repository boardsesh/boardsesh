import Yoga from 'yoga-layout';
import { describe, expect, it } from 'vitest';
import { STACKED_CANVAS_MIN_HEIGHT, STACKED_TOOLBAR_MAX_HEIGHT } from '../layout-constraints';

function percentage(styleValue: string): number {
  return Number.parseFloat(styleValue);
}

function measureStackedLayout(routeHeight: number, intrinsicToolbarHeight: number, bounded: boolean) {
  const route = Yoga.Node.create();
  route.setWidth(390);
  route.setHeight(routeHeight);
  route.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);

  const board = Yoga.Node.create();
  board.setFlex(1);
  if (bounded) board.setMinHeightPercent(percentage(STACKED_CANVAS_MIN_HEIGHT));

  const toolbar = Yoga.Node.create();
  // React Native's ScrollView style supplies flexShrink: 1; the screen
  // overrides only flexGrow and the new maxHeight boundary.
  toolbar.setFlexGrow(0);
  toolbar.setFlexShrink(1);
  if (bounded) toolbar.setMaxHeightPercent(percentage(STACKED_TOOLBAR_MAX_HEIGHT));

  const controls = Yoga.Node.create();
  controls.setHeight(intrinsicToolbarHeight);
  toolbar.insertChild(controls, 0);

  route.insertChild(board, 0);
  route.insertChild(toolbar, 1);
  route.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);

  const measured = {
    boardHeight: board.getComputedHeight(),
    toolbarHeight: toolbar.getComputedHeight(),
    toolbarContentHeight: controls.getComputedHeight(),
  };
  route.freeRecursive();
  return measured;
}

describe('outline editor stacked Yoga constraints', () => {
  it('reproduces the zero-height board when an expanded toolbar is unbounded', () => {
    const layout = measureStackedLayout(400, 650, false);

    expect(layout.boardHeight).toBe(0);
    expect(layout.toolbarHeight).toBe(400);
  });

  it.each([
    ['compact portrait', 380, 720],
    ['narrow Split View with large controls', 520, 980],
    ['expanded plated-layout controls', 720, 1_240],
  ] as const)('%s keeps the canvas visible and the controls scrollable', (_label, routeHeight, toolbarHeight) => {
    const layout = measureStackedLayout(routeHeight, toolbarHeight, true);

    expect(layout.boardHeight).toBeGreaterThanOrEqual(routeHeight / 2);
    expect(layout.toolbarHeight).toBeLessThanOrEqual(routeHeight / 2);
    expect(layout.toolbarContentHeight).toBeGreaterThan(layout.toolbarHeight);
  });
});
