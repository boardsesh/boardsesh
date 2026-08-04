// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// What these tests are about: the relations the zoom hook declares with the
// surrounding scroll. The pan only mounts while zoomed, so it must WIN a downward
// drag from the play drawer's RNGH ScrollView — otherwise the drawer scrolls out
// from under a zoomed board instead of panning it. The interactive create/search
// boards pass no scrollRef and must stay relation-free.

// Mirror reanimated's contract: useSharedValue returns the SAME mutable ref across
// re-renders; animations resolve to their target synchronously.
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withTiming: (toValue: unknown) => toValue,
    cancelAnimation: () => {},
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

// Chainable Gesture builder that records which methods were called with what, so a
// test can assert the declared relations without a native gesture tree.
type RecordedBuilder = { kind: string; calls: Array<{ method: string; args: unknown[] }> };
const recordedBuilders: RecordedBuilder[] = [];
vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = (kind: string) => {
    const record: RecordedBuilder = { kind, calls: [] };
    recordedBuilders.push(record);
    const proxy: Record<string, (...args: unknown[]) => unknown> = new Proxy(
      {},
      {
        get: (_target, method: string) => {
          return (...args: unknown[]) => {
            record.calls.push({ method, args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return {
    Gesture: { Pinch: () => makeBuilder('Pinch'), Pan: () => makeBuilder('Pan') },
  };
});

import { useZoomPanGesture } from '../use-zoom-pan-gesture';

type Options = Parameters<typeof useZoomPanGesture>[0];

const scrollRef = { current: null } as unknown as NonNullable<Options['scrollRef']>;

function builderOfKind(kind: string): RecordedBuilder {
  const found = recordedBuilders.find((builder) => builder.kind === kind);
  if (!found) throw new Error(`no Gesture.${kind}() composed`);
  return found;
}

function methodsOf(kind: string): string[] {
  return builderOfKind(kind).calls.map((call) => call.method);
}

describe('useZoomPanGesture scroll relations', () => {
  beforeEach(() => {
    recordedBuilders.length = 0;
  });

  it('makes the zoomed-only pan block the surrounding scroll', () => {
    renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, scrollRef }));

    const blocks = builderOfKind('Pan').calls.filter((call) => call.method === 'blocksExternalGesture');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.args[0]).toBe(scrollRef);
  });

  it('keeps the pinch simultaneous with that scroll (a 2-finger zoom must not be a scroll)', () => {
    renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, scrollRef }));

    const simultaneous = builderOfKind('Pinch').calls.filter(
      (call) => call.method === 'simultaneousWithExternalGesture',
    );
    expect(simultaneous).toHaveLength(1);
    expect(simultaneous[0]?.args[0]).toBe(scrollRef);
  });

  it('declares no scroll relation on the interactive boards, which pass no scrollRef', () => {
    renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480 }));

    expect(methodsOf('Pan')).not.toContain('blocksExternalGesture');
    expect(methodsOf('Pinch')).not.toContain('simultaneousWithExternalGesture');
  });
});
