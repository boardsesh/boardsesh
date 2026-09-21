// @vitest-environment jsdom
import React, { type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SharedValue } from 'react-native-reanimated';

const handlers = vi.hoisted(() => ({
  start: null as ((event: { x: number; y: number }) => void) | null,
  update: null as ((event: { x: number; y: number }) => void) | null,
}));

vi.mock('react-native', () => ({
  View: () => React.createElement('div'),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (value: unknown) => useRef({ value }).current,
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
  };
});
vi.mock('react-native-gesture-handler', () => {
  const gesture = {
    minPointers: () => gesture,
    manualActivation: () => gesture,
    onTouchesDown: () => gesture,
    onStart: (handler: NonNullable<typeof handlers.start>) => {
      handlers.start = handler;
      return gesture;
    },
    onUpdate: (handler: NonNullable<typeof handlers.update>) => {
      handlers.update = handler;
      return gesture;
    },
    onEnd: () => gesture,
    onFinalize: () => gesture,
    simultaneousWithExternalGesture: () => gesture,
  };
  return {
    Gesture: { Pan: () => gesture },
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    PointerType: { STYLUS: 1 },
  };
});

import { DrawStrokeOverlay } from '../DrawStrokeOverlay';

const shared = <T,>(value: T) => ({ value }) as SharedValue<T>;

it('stops UI-thread samples after Undo and resumes only with a fresh stroke', () => {
  const points = shared<number[]>([]);
  const active = shared(false);
  const onStart = vi.fn();
  render(
    <DrawStrokeOverlay
      pointsSV={points}
      strokeLiveSV={active}
      fingerDrawSV={shared(false)}
      scaleSV={shared(1)}
      translateXSV={shared(0)}
      translateYSV={shared(0)}
      containerWidthSV={shared(100)}
      containerHeightSV={shared(100)}
      boardScale={1}
      pinchRef={{ current: undefined }}
      onStrokeStart={onStart}
      onStrokeEnd={vi.fn()}
      onStrokeCancel={vi.fn()}
    />,
  );
  handlers.start?.({ x: 10, y: 10 });
  handlers.update?.({ x: 20, y: 20 });
  expect(points.value).toEqual([10, 10, 20, 20]);

  const restoredRing = [1, 2, 3, 4, 1, 2];
  active.value = false;
  points.value = restoredRing;
  handlers.update?.({ x: 50, y: 50 });
  expect(points.value).toBe(restoredRing);

  handlers.start?.({ x: 70, y: 70 });
  handlers.update?.({ x: 80, y: 80 });
  expect(points.value).toEqual([70, 70, 80, 80]);
  expect(onStart).toHaveBeenCalledTimes(2);
});

it('keeps sampling for the spray editor without an external lifecycle flag', () => {
  const points = shared<number[]>([]);
  render(
    <DrawStrokeOverlay
      pointsSV={points}
      fingerDrawSV={shared(false)}
      scaleSV={shared(1)}
      translateXSV={shared(0)}
      translateYSV={shared(0)}
      containerWidthSV={shared(100)}
      containerHeightSV={shared(100)}
      boardScale={1}
      pinchRef={{ current: undefined }}
      onStrokeStart={vi.fn()}
      onStrokeEnd={vi.fn()}
      onStrokeCancel={vi.fn()}
    />,
  );
  handlers.start?.({ x: 10, y: 10 });
  handlers.update?.({ x: 20, y: 20 });
  expect(points.value).toEqual([10, 10, 20, 20]);
});
