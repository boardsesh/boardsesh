// @vitest-environment jsdom
// The lit wall button's fill (#7000, F1b): blobs, fade, frost and grain from a
// layer, and a 200 ms cross-fade between climbs that Reduce Motion skips.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const motion = vi.hoisted(() => ({ reduce: false, timings: [] as { toValue: number; duration: number }[] }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => motion.reduce }));
vi.mock('@boardsesh/frosted-bokeh/grain.png', () => ({ default: 1 }));

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
