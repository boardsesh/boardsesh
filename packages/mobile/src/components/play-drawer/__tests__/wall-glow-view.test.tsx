// @vitest-environment jsdom
// The lit wall button's fill (#7000, F1b): blobs, fade, frost and grain from a
// layer, and a 200 ms cross-fade between climbs that Reduce Motion skips.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const motion = vi.hoisted(() => ({ reduce: false, timings: [] as { toValue: number; duration: number }[] }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => motion.reduce }));
vi.mock('@boardsesh/frosted-bokeh/grain.png', () => ({ default: 1 }));

// The Metal view: present (an iOS binary with the module) unless a test says not.
type GpuProps = {
  testID?: string;
  blobs: { peak: number }[];
  layerKey: string;
  reduceMotion: boolean;
  drift: number;
  swell: number;
  glideMs: number;
  onRenderError?: () => void;
};
const gpu = vi.hoisted(() => ({ present: true, last: null as GpuProps | null }));
vi.mock('../../../../modules/frosted-bokeh-gpu/src/index', () => ({
  get NativeFrostedBokehGPU() {
    return gpu.present
      ? (props: GpuProps) => {
          gpu.last = props;
          return createElement('canvas', { 'data-testid': props.testID, 'data-key': props.layerKey });
        }
      : null;
  },
}));

type Style = Record<string, unknown> | null | undefined | false | Style[];
const flatten = (style: Style): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ? style : {};

vi.mock('react-native', () => {
  class Value {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      this.value = value;
    }
  }
  const view = ({ testID, style, children }: { testID?: string; style?: Style; children?: ReactNode }) => {
    const flat = flatten(style);
    return createElement(
      'div',
      {
        'data-testid': testID,
        'data-blend': flat.mixBlendMode ?? '',
        'data-image': flat.experimental_backgroundImage ?? '',
        'data-bg': flat.backgroundColor ?? '',
        'data-faded': flat.opacity instanceof Value ? 'animated' : '',
        'data-style': JSON.stringify(flat),
      },
      children,
    );
  };
  return {
    View: view,
    Image: ({ style }: { style?: Style }) =>
      createElement('img', { 'data-testid': 'wall-glow-grain', 'data-opacity': String(flatten(style).opacity) }),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Animated: {
      Value,
      View: view,
      timing: (_value: Value, config: { toValue: number; duration: number }) => {
        motion.timings.push(config);
        return { start: () => undefined, stop: () => undefined };
      },
    },
  };
});

import { WallGlow } from '../WallGlow';
import { FrostedBokeh } from '../../FrostedBokeh';
import type { WallGlowLayer } from '../use-wall-glow';

afterEach(() => {
  cleanup();
  motion.reduce = false;
  motion.timings = [];
  gpu.present = true;
  gpu.last = null;
  vi.useRealTimers();
});

function layer(overrides: Partial<WallGlowLayer> = {}): WallGlowLayer {
  return {
    key: 'climb-1',
    blobs: [
      { x: 20, y: 10, r: 40, color: '#00DD00', peak: 0.3, gradient: 'radial-gradient(green)' },
      { x: 300, y: 30, r: 40, color: '#FF0000', peak: 0.3, gradient: 'radial-gradient(red)' },
    ],
    fade: 0.2,
    surface: { base: '#0E0D12', label: '#FFFFFF', frost: true, border: 'rgba(255, 255, 255, 0.2)' },
    blend: 'screen',
    opacityScale: 1,
    ...overrides,
  };
}

describe('WallGlow', () => {
  it('reuses the background independently of the button label policy', () => {
    const view = render(createElement(FrostedBokeh, { layer: layer() }));
    expect(view.getByTestId('frosted-bokeh').dataset.bg).toBe('#0E0D12');
    expect(view.getByTestId('frosted-bokeh-blobs').children).toHaveLength(2);
    expect(view.getByTestId('frosted-bokeh-frost')).toBeTruthy();
    expect(view.queryByTestId('wall-glow-label-fade')).toBeNull();
  });

  it('draws each blob, screened, on the dark base with the fade, the frost and the grain', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360 }));
    expect(view.getByTestId('wall-glow').dataset.bg).toBe('#0E0D12');
    const group = view.getByTestId('wall-glow-blobs');
    expect(group.dataset.blend).toBe('screen');
    expect([...group.children].map((blob) => (blob as HTMLElement).dataset.image)).toEqual([
      'radial-gradient(green)',
      'radial-gradient(red)',
    ]);
    expect(view.getByTestId('wall-glow-label-fade').dataset.image).toContain('rgba(14, 13, 18, 0.2)');
    expect(view.getByTestId('wall-glow-frost')).toBeTruthy();
    expect(view.getByTestId('wall-glow-grain').dataset.opacity).toBe('0.06');
  });

  it('multiplies on the pale light base, with no frost and no fade when none is needed', () => {
    const view = render(
      createElement(WallGlow, {
        layer: layer({
          blend: 'multiply',
          fade: 0,
          surface: { base: '#F6F3FB', label: '#16111F', frost: false, border: 'rgba(0, 0, 0, 0.12)' },
        }),
        width: 360,
      }),
    );
    expect(view.getByTestId('wall-glow').dataset.bg).toBe('#F6F3FB');
    expect(view.getByTestId('wall-glow-blobs').dataset.blend).toBe('multiply');
    expect(view.queryByTestId('wall-glow-frost')).toBeNull();
    expect(view.queryByTestId('wall-glow-label-fade')).toBeNull();
  });

  it('protects both header lines and their edges with a uniform full-surface scrim before frost', () => {
    const view = render(createElement(WallGlow, { layer: layer({ readableZone: 'full' }), width: 80 }));
    const fade = view.getByTestId('wall-glow-label-fade');
    expect(fade.dataset.image).toBe('');
    expect(fade.dataset.bg).toBe('rgba(14, 13, 18, 0.2)');
    expect(JSON.parse(fade.dataset.style ?? '{}')).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(JSON.parse(fade.dataset.style ?? '{}').width).toBeUndefined();
    const children = [...view.getByTestId('wall-glow').children];
    expect(children.indexOf(fade)).toBeLessThan(children.indexOf(view.getByTestId('wall-glow-frost')));
    expect(children.indexOf(fade)).toBeGreaterThan(children.indexOf(view.getByTestId('wall-glow-blobs')));
  });

  it('retains the player’s existing centered gradient when no readable zone is supplied', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360 }));
    const fade = view.getByTestId('wall-glow-label-fade');
    expect(fade.dataset.bg).toBe('');
    expect(fade.dataset.image).toBe(
      'linear-gradient(to right, transparent 0%, rgba(14, 13, 18, 0.2) 10%, rgba(14, 13, 18, 0.2) 90%, transparent 100%)',
    );
    const fadeStyle = JSON.parse(fade.dataset.style ?? '{}') as Record<string, unknown>;
    expect(fadeStyle.left).toBeCloseTo(43.2);
    expect(fadeStyle.width).toBeCloseTo(273.6);
  });

  it('blends nothing on old Android', () => {
    const view = render(createElement(WallGlow, { layer: layer({ blend: 'normal', opacityScale: 0.6 }), width: 360 }));
    expect(view.getByTestId('wall-glow-blobs').dataset.blend).toBe('');
  });

  it('cross-fades over 200 ms to the next climb, keeping the last one under it meanwhile', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360 }));
    view.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2' }), width: 360 }));
    expect(motion.timings).toEqual([expect.objectContaining({ toValue: 1, duration: 200 })]);
    const groups = view.getAllByTestId('wall-glow-blobs');
    expect(groups).toHaveLength(2);
    expect(groups[1]?.dataset.faded).toBe('animated');
  });

  it('swaps at once with Reduce Motion on, and never cross-fades a resize of the same climb', () => {
    motion.reduce = true;
    const view = render(createElement(WallGlow, { layer: layer(), width: 360 }));
    view.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2' }), width: 360 }));
    expect(motion.timings).toEqual([]);
    expect(view.getAllByTestId('wall-glow-blobs')).toHaveLength(1);

    motion.reduce = false;
    view.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2' }), width: 239 }));
    expect(motion.timings).toEqual([]);
  });
});

describe('WallGlow, moving on the GPU', () => {
  it('hands the blobs, the motion constants and the key to the Metal view instead of drawing them', () => {
    const view = render(
      createElement(WallGlow, { layer: layer({ blend: 'multiply', opacityScale: 0.6 }), width: 360, moving: true }),
    );
    expect(view.getByTestId('wall-glow-gpu').dataset.key).toBe('climb-1');
    expect(view.queryByTestId('wall-glow-blobs')).toBeNull();
    // The gradients bake the opacity scale in; the shader gets it in peak.
    expect(gpu.last?.blobs.map((blob) => blob.peak)).toEqual([0.18, 0.18]);
    expect(gpu.last).toMatchObject({ drift: 3.5, swell: 0.14, glideMs: 700, reduceMotion: false });
    // The fade, the frost and the grain stay React Native, over the shader.
    expect(view.getByTestId('wall-glow-label-fade')).toBeTruthy();
    expect(view.getByTestId('wall-glow-frost')).toBeTruthy();
  });

  it('glides in the shader, so React Native runs no cross-fade of its own', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360, moving: true }));
    view.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2' }), width: 360, moving: true }));
    expect(motion.timings).toEqual([]);
    expect(view.getByTestId('wall-glow-gpu').dataset.key).toBe('climb-2');
  });

  it('keeps the still blobs on a binary without the module', () => {
    gpu.present = false;
    const view = render(createElement(WallGlow, { layer: layer(), width: 360, moving: true }));
    expect(view.queryByTestId('wall-glow-gpu')).toBeNull();
    expect(view.getByTestId('wall-glow-blobs').children).toHaveLength(2);
  });

  it('falls back to the still blobs for good when the shader reports it cannot draw', () => {
    const view = render(createElement(WallGlow, { layer: layer(), width: 360, moving: true }));
    act(() => gpu.last?.onRenderError?.());
    expect(view.queryByTestId('wall-glow-gpu')).toBeNull();
    expect(view.getByTestId('wall-glow-blobs').children).toHaveLength(2);
  });

  it('holds the stronger of the two fades through the glide, then settles on the new one', () => {
    vi.useFakeTimers();
    const view = render(createElement(WallGlow, { layer: layer({ fade: 0.5 }), width: 360, moving: true }));
    view.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2', fade: 0.2 }), width: 360, moving: true }));
    expect(view.getByTestId('wall-glow-label-fade').dataset.image).toContain('rgba(14, 13, 18, 0.5)');
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(view.getByTestId('wall-glow-label-fade').dataset.image).toContain('rgba(14, 13, 18, 0.2)');
  });

  it('switches to the new fade at once when the new climb needs the stronger one, or nothing moves', () => {
    const view = render(createElement(WallGlow, { layer: layer({ fade: 0.2 }), width: 360, moving: true }));
    view.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2', fade: 0.65 }), width: 360, moving: true }));
    expect(view.getByTestId('wall-glow-label-fade').dataset.image).toContain('rgba(14, 13, 18, 0.65)');

    const still = render(createElement(WallGlow, { layer: layer({ fade: 0.5 }), width: 360 }));
    still.rerender(createElement(WallGlow, { layer: layer({ key: 'climb-2', fade: 0.2 }), width: 360 }));
    expect(still.getAllByTestId('wall-glow-label-fade').at(-1)?.dataset.image).toContain('rgba(14, 13, 18, 0.2)');
  });

  it('drops the hold for good once the climb’s own fade rises past it', () => {
    vi.useFakeTimers();
    const glow = (key: string, fade: number) =>
      createElement(WallGlow, { layer: layer({ key, fade }), width: 360, moving: true });
    const view = render(glow('climb-1', 0.8));
    view.rerender(glow('climb-2', 0.2));
    view.rerender(glow('climb-2', 0.9));
    view.rerender(glow('climb-2', 0.3));
    expect(view.getByTestId('wall-glow-label-fade').dataset.image).toContain('rgba(14, 13, 18, 0.3)');
  });
});
