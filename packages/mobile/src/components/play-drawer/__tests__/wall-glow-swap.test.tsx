// @vitest-environment jsdom
// The wall button's frost on a binary that follows the board's swap (option I,
// `swapFrameApi` 1): the neighbours, the look and the release timings go to the
// native view as props, the board's frames go as the `swapFrame` command from
// the UI thread, and the label fade covers both climbs while a pair is shown.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('@boardsesh/frosted-bokeh/grain.png', () => ({ default: 1 }));

type GpuProps = {
  testID?: string;
  blobs: { peak: number; id?: number; seed?: number }[];
  layerKey: string;
  glideMs?: number;
  swapClimbs?: {
    centerPage: number;
    previous?: { key: string; blobs: { id?: number; seed?: number }[] };
    next?: { key: string; blobs: { id?: number; seed?: number }[] };
  } | null;
  swapLook?: readonly number[] | null;
  releaseMs?: number;
  releaseOutMs?: number;
  animatedProps?: { swapFrame: readonly number[] };
};
const gpu = vi.hoisted(() => ({ last: null as GpuProps | null }));
vi.mock('../../../../modules/frosted-bokeh-gpu/src/index', () => ({
  frostedBokehSwapFrameApi: 1,
  NativeFrostedBokehGPU: (props: GpuProps) => {
    gpu.last = props;
    return null;
  },
}));

const animation = vi.hoisted(() => ({
  reactions: [] as (() => void)[],
  dispatched: [] as { name: string; args: readonly number[] }[],
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: ({ style, testID }: { style?: unknown; testID?: string }) =>
        createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style) }),
    },
    useAnimatedProps: (factory: () => unknown) => factory(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useAnimatedRef: () => useRef({ commandTarget: true }).current,
    useSharedValue: <Value,>(initial: Value) => useRef({ value: initial }).current,
    useAnimatedReaction: <Prepared,>(prepare: () => Prepared, react: (prepared: Prepared) => void) => {
      animation.reactions.push(() => react(prepare()));
    },
    dispatchCommand: (_target: unknown, name: string, args: readonly number[]) =>
      animation.dispatched.push({ name, args }),
  };
});

type Style = Record<string, unknown> | null | undefined | false | Style[];
const flatten = (style: Style): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ? style : {};
vi.mock('react-native', () => {
  const view = ({ testID, style, children }: { testID?: string; style?: Style; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flatten(style)) }, children);
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
  }
  return {
    View: view,
    Image: () => null,
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Animated: { Value, View: view, timing: () => ({ start: () => undefined, stop: () => undefined }) },
  };
});

import { WallGlow, type WallGlowSwap } from '../WallGlow';
import type { WallGlowLayer } from '../use-wall-glow';
import type { BoardSwapFrame } from '../swap-look';

afterEach(() => {
  cleanup();
  gpu.last = null;
  animation.reactions = [];
  animation.dispatched = [];
});

function layer(key: string, fade: number, ids: number[]): WallGlowLayer {
  return {
    key,
    blobs: ids.map((id, index) => ({
      x: 40 + index * 100,
      y: 20,
      r: 40,
      color: '#00DD00',
      peak: 0.5,
      id,
      gradient: 'radial-gradient(green)',
    })),
    fade,
    surface: { base: '#0E0D12', label: '#FFFFFF', frost: true, border: 'rgba(255, 255, 255, 0.2)' },
    blend: 'screen',
    opacityScale: 1,
  };
}

const LOOK = [2, 0.25, 0.25, 0.4, 0.4, 0, 0, 0.4, 0.15, 0.05, 0.25, 0, 2, 0.35, 0] as const;

function swapWith(frame: BoardSwapFrame | null, next: WallGlowLayer | null): WallGlowSwap {
  return {
    frames: { value: frame } as unknown as WallGlowSwap['frames'],
    centerPage: 5,
    previous: null,
    next,
    look: LOOK,
  };
}

/** Run every UI-thread reaction once, as the frame changes. */
function runReactions() {
  for (const reaction of animation.reactions) reaction();
}

describe('the frost following the board swap', () => {
  it('hands the native view the neighbours, the look and the release timings instead of the glide', () => {
    render(
      createElement(WallGlow, {
        layer: layer('climb-5', 0.2, [1, 2]),
        width: 360,
        moving: true,
        swap: swapWith(null, layer('climb-6', 0.5, [2, 3])),
      }),
    );
    const props = gpu.last;
    expect(props?.glideMs).toBeUndefined();
    expect(props).toMatchObject({ releaseMs: 220, releaseOutMs: 150, swapLook: LOOK });
    expect(props).not.toHaveProperty('dissolveMs');
    expect(props?.swapClimbs?.centerPage).toBe(5);
    // A missing neighbour is left out, never null: iOS drops the whole record on a null nested record.
    expect(props?.swapClimbs).not.toHaveProperty('previous');
    expect(props?.swapClimbs?.next?.key).toBe('climb-6');
    // Every light carries its hold id and a breathing seed, so a shared hold is
    // matched and keeps its phase when its slot changes.
    expect(props?.blobs.map((blob) => blob.id)).toEqual([1, 2]);
    expect(props?.swapClimbs?.next?.blobs.map((blob) => blob.id)).toEqual([2, 3]);
    expect(props?.blobs[1]?.seed).toBe(props?.swapClimbs?.next?.blobs[0]?.seed);
    expect(props?.blobs.every((blob) => typeof blob.seed === 'number' && blob.seed >= 0)).toBe(true);
    // The animated prop starts on "no frames", below every real sequence.
    expect(props?.animatedProps?.swapFrame).toEqual([0]);
  });

  it('sends each board frame as the swapFrame command, sequenced, and "no frames" when the board stops', () => {
    const swap = swapWith([5.25, 0.6, 0.3, 1, 0, 1], layer('climb-6', 0.5, [3]));
    render(createElement(WallGlow, { layer: layer('climb-5', 0.2, [1]), width: 360, moving: true, swap }));
    runReactions();
    expect(animation.dispatched).toEqual([{ name: 'swapFrame', args: [5.25, 0.6, 0.3, 1, 1, 0, 1] }]);
    (swap.frames as unknown as { value: BoardSwapFrame | null }).value = [6, 1, 0, 1];
    runReactions();
    (swap.frames as unknown as { value: BoardSwapFrame | null }).value = null;
    runReactions();
    expect(animation.dispatched.slice(1)).toEqual([
      { name: 'swapFrame', args: [6, 1, 0, 1, 2] },
      { name: 'swapFrame', args: [3] },
    ]);
  });

  it('sends no frames and no neighbours without a board swap', () => {
    render(createElement(WallGlow, { layer: layer('climb-5', 0.2, [1]), width: 360, moving: true }));
    runReactions();
    expect(animation.dispatched).toEqual([]);
    expect(gpu.last?.swapClimbs).toBeNull();
    expect(gpu.last?.releaseMs).toBe(220);
  });

  it('draws the label fade at the stronger climb and dims it to the climb on show at rest', () => {
    const view = render(
      createElement(WallGlow, {
        layer: layer('climb-5', 0.2, [1]),
        width: 360,
        moving: true,
        swap: swapWith([5, 1, 0, 1, 0, 0], layer('climb-6', 0.5, [3])),
      }),
    );
    const fade = view.getByTestId('wall-glow-label-fade');
    expect(fade.dataset.style).toContain('rgba(14, 13, 18, 0.5)');
    expect(JSON.parse(fade.dataset.style ?? '[]')[1]).toEqual({ opacity: 0.4 });
  });

  it('keeps the stronger fade whole while the board shows the pair', () => {
    const view = render(
      createElement(WallGlow, {
        layer: layer('climb-5', 0.2, [1]),
        width: 360,
        moving: true,
        swap: swapWith([5.25, 0.6, 0.3, 1, 0, 1], layer('climb-6', 0.5, [3])),
      }),
    );
    const fade = view.getByTestId('wall-glow-label-fade');
    expect(JSON.parse(fade.dataset.style ?? '[]')[1]).toEqual({ opacity: 1 });
  });

  it('draws the full-surface fade when a neighbour needs it', () => {
    const view = render(
      createElement(WallGlow, {
        layer: layer('climb-5', 0.2, [1]),
        width: 360,
        moving: true,
        swap: swapWith([5, 1, 0, 1, 0, 0], { ...layer('climb-6', 0.5, [3]), readableZone: 'full' }),
      }),
    );
    const style = JSON.parse(view.getByTestId('wall-glow-label-fade').dataset.style ?? '[]');
    expect(style[0][0]).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(style[0][1]).toEqual({ backgroundColor: 'rgba(14, 13, 18, 0.5)' });
  });
});
