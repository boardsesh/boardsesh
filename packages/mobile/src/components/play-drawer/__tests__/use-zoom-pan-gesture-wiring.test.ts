// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// What these tests are about: the relations the zoom hook declares with the two
// ancestors that compete for the same downward drag — the play drawer's RNGH
// ScrollView and its pull-down-to-dismiss Pan. The zoom pan only mounts while
// zoomed, so it must WIN that drag from both; otherwise the drawer scrolls (or
// slides away) out from under a zoomed board instead of the board panning. The
// interactive create/search boards pass neither ref and must stay relation-free.

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
const dismissRef = { current: undefined } as NonNullable<Options['dismissRef']>;

function builderOfKind(kind: string): RecordedBuilder {
  const found = recordedBuilders.filter((builder) => builder.kind === kind);
  // Insist on exactly one so a future test that re-renders (recomposing the gesture)
  // can't quietly assert against the discarded first build and read as green.
  if (found.length !== 1) throw new Error(`expected 1 Gesture.${kind}(), composed ${found.length}`);
  return found[0] as RecordedBuilder;
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

  it("makes the zoomed-only pan block the drawer's pull-down-to-dismiss pan", () => {
    renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, scrollRef, dismissRef }));

    const blocked = builderOfKind('Pan')
      .calls.filter((call) => call.method === 'blocksExternalGesture')
      .map((call) => call.args[0]);
    expect(blocked).toContain(dismissRef);
  });

  it('declares no dismiss relation when the host passes no dismissRef', () => {
    renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, scrollRef }));

    // Only the scroll relation — nothing accidentally blocking a gesture the host
    // never handed us.
    const blocks = builderOfKind('Pan').calls.filter((call) => call.method === 'blocksExternalGesture');
    expect(blocks.map((call) => call.args[0])).toEqual([scrollRef]);
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
