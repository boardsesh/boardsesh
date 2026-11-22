// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedValue } from 'react-native-reanimated';
import type { SprayEditorHold } from '../spray-hold-editor-reducer';

const observed = vi.hoisted(() => ({
  pathUpdates: [] as string[],
  sharedValues: [] as Array<{ value: unknown }>,
  deferJS: false,
  pendingJS: [] as Array<() => void>,
  animatedProps: [] as Array<() => Record<string, unknown>>,
  reactions: [] as Array<{
    prepare: () => unknown;
    react: (next: unknown, previous: unknown) => void;
    previous: unknown;
  }>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
}));
vi.mock('../../../theme/tokens', () => ({ overlays: { onScrim: 'white', scrim: 'black' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { accent: 'violet' } }),
}));
vi.mock('react-native-svg', () => ({
  default: ({
    children,
    width,
    height,
    viewBox,
  }: {
    children?: ReactNode;
    width: number;
    height: number;
    viewBox: string;
  }) => (
    <svg data-testid="canvas" width={width} height={height} viewBox={viewBox}>
      {children}
    </svg>
  ),
  G: ({ children }: { children?: ReactNode }) => <g>{children}</g>,
  Path: ({
    d,
    animatedProps,
    stroke,
    strokeWidth,
  }: {
    d?: string;
    animatedProps?: { d?: string };
    stroke?: string;
    strokeWidth?: number;
  }) => {
    const path = d ?? animatedProps?.d ?? '';
    observed.pathUpdates.push(path);
    return <path d={path} stroke={stroke} strokeWidth={strokeWidth} />;
  },
}));
vi.mock('react-native-reanimated', async () => {
  const react = await import('react');
  return {
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
    ReduceMotion: { System: 'system', Never: 'never' },
    withTiming: (next: number) => next,
    withDelay: () => 0,
    useAnimatedStyle: (style: () => unknown) => style(),
    runOnJS:
      (callback: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (observed.deferJS) observed.pendingJS.push(() => callback(...args));
        else callback(...args);
      },
    runOnUI: (callback: unknown) => callback,
    useSharedValue: <T,>(initial: T) => {
      const reference = react.useRef({ value: initial });
      react.useEffect(() => {
        observed.sharedValues.push(reference.current);
      }, []);
      return reference.current;
    },
    useDerivedValue: <T,>(derive: () => T) => ({
      get value() {
        return derive();
      },
    }),
    useAnimatedProps: (produce: () => Record<string, unknown>) => {
      observed.animatedProps.push(produce);
      return produce();
    },
    useAnimatedReaction: (prepare: () => unknown, reaction: (next: unknown, previous: unknown) => void) => {
      const callbacks = react.useRef({ prepare, reaction });
      callbacks.current = { prepare, reaction };
      react.useEffect(() => {
        const record = {
          prepare: () => callbacks.current.prepare(),
          react: (next: unknown, previous: unknown) => callbacks.current.reaction(next, previous),
          previous: null as unknown,
        };
        observed.reactions.push(record);
        record.react(record.prepare(), null);
        record.previous = record.prepare();
        return () => {
          observed.reactions = observed.reactions.filter((entry) => entry !== record);
        };
      }, []);
    },
  };
});

import { SprayHoldSvgLayer } from '../SprayHoldSvgLayer';
import { SprayLoupe } from '../SprayLoupe';
import { SprayLoupeViewportContext, type SprayLoupeViewport } from '../spray-loupe-viewport';

function shared<T>(initial: T): SharedValue<T> {
  return { value: initial } as unknown as SharedValue<T>;
}
function wall(count: number): SprayEditorHold[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    cx: 20 + (index % 40) * 45,
    cy: 20 + Math.floor(index / 40) * 45,
    r: 10,
    outline: null,
    source: 'MANUAL',
    confidence: null,
    review: 'accepted',
    dirty: false,
  }));
}
function props(holds: readonly SprayEditorHold[]) {
  return {
    holds,
    showMaybes: true,
    selectedId: null,
    maybeOpacitySV: shared(1),
    draftPointsSV: shared<number[]>([]),
    scaleSV: shared(1),
    boardWidth: 2048,
    boardHeight: 2048,
    renderWidth: 512,
    renderHeight: 512,
  };
}
function flushReactions() {
  act(() => {
    for (const record of observed.reactions) {
      const next = record.prepare();
      if (next !== record.previous) record.react(next, record.previous);
      record.previous = next;
    }
  });
}
beforeEach(() => {
  observed.sharedValues = [];
  observed.deferJS = false;
  observed.pendingJS = [];
  observed.pathUpdates = [];
  observed.animatedProps = [];
  observed.reactions = [];
});

describe('native spray render isolation', () => {
  it('mounts matching sibling canvases, with committed paths outside the live root', () => {
    const view = render(<SprayHoldSvgLayer {...props(wall(50))} />);
    const canvases = view.getAllByTestId('canvas');
    expect(canvases).toHaveLength(2);
    expect(canvases[0].parentElement).toBe(canvases[1].parentElement);
    expect(canvases[0].contains(canvases[1])).toBe(false);
    for (const canvas of canvases) {
      expect(canvas.getAttribute('viewBox')).toBe('0 0 2048 2048');
      expect(canvas.getAttribute('width')).toBe('512');
      expect(canvas.getAttribute('height')).toBe('512');
    }
    expect(canvases[0].querySelectorAll('path')).toHaveLength(4);
    expect(canvases[1].querySelectorAll('path')).toHaveLength(2);
  });

  it.each([530, 1500])('a completed addition updates only two native paths on a %s-hold wall', (count) => {
    const holds = wall(count);
    const layerProps = props(holds);
    const view = render(<SprayHoldSvgLayer {...layerProps} />);
    observed.pathUpdates = [];
    view.rerender(<SprayHoldSvgLayer {...layerProps} holds={[{ ...holds[0], id: -1 }, ...holds]} />);
    expect(observed.pathUpdates.filter((path) => path.endsWith('Z'))).toHaveLength(2);
  });

  it('live samples do not update committed native props', () => {
    const layerProps = props(wall(1500));
    render(<SprayHoldSvgLayer {...layerProps} />);
    observed.pathUpdates = [];
    layerProps.draftPointsSV.value = [10, 10, 20, 20, 30, 10];
    const updated = observed.animatedProps.map((produce) => produce()).filter((entry) => typeof entry.d === 'string');
    expect(updated.some((entry) => entry.d === 'M10 10L20 20L30 10')).toBe(true);
    expect(observed.pathUpdates).toHaveLength(0);
  });

  it('keeps global role stacking and removes hidden maybes', () => {
    const holds = wall(70);
    holds[0] = { ...holds[0], review: 'rejected' };
    holds[1] = { ...holds[1], source: 'AUTO', review: 'pending', confidence: 0.4 };
    const layerProps = props(holds);
    const view = render(<SprayHoldSvgLayer {...layerProps} />);
    const staticCanvas = view.getAllByTestId('canvas')[0];
    expect(
      Array.from(staticCanvas.querySelectorAll('path'))
        .slice(0, 3)
        .map((path) => path.getAttribute('stroke')),
    ).toEqual(['white', 'black', 'violet']);
    view.rerender(<SprayHoldSvgLayer {...layerProps} showMaybes={false} />);
    expect(staticCanvas.querySelector('path[stroke="violet"]')).toBeNull();
  });

  it('a cold magnifier only mounts local geometry, then catches a viewport jump', () => {
    const layerProps = props(wall(1500));
    const viewport: SprayLoupeViewport = {
      centerXSV: shared(100),
      centerYSV: shared(100),
      magnificationSV: shared(4),
      readySV: shared(false),
      renderWidth: 512,
      renderHeight: 512,
    };
    const view = render(
      <SprayLoupeViewportContext.Provider value={viewport}>
        <SprayHoldSvgLayer {...layerProps} />
      </SprayLoupeViewportContext.Provider>,
    );
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
    const before = Array.from(view.getAllByTestId('canvas')[0].querySelectorAll('path')).map((path) =>
      path.getAttribute('d'),
    );
    // Halo and line share d; count local geometry once rather than twice.
    const uniqueGeometry = [...new Set(before)].join('');
    expect(uniqueGeometry.match(/M/g)?.length ?? 0).toBeLessThan(150);
    for (const path of before) expect(path?.match(/M/g)?.length ?? 0).toBeLessThanOrEqual(32);
    viewport.centerXSV.value = 400;
    viewport.centerYSV.value = 350;
    flushReactions();
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
    const after = Array.from(view.getAllByTestId('canvas')[0].querySelectorAll('path')).map((path) =>
      path.getAttribute('d'),
    );
    expect(after).not.toEqual(before);
  });
  it('returning to the mounted viewport restores visibility with JS callbacks pending', () => {
    const layerProps = props(wall(1500));
    const viewport: SprayLoupeViewport = {
      centerXSV: shared(100),
      centerYSV: shared(100),
      magnificationSV: shared(4),
      readySV: shared(false),
      renderWidth: 512,
      renderHeight: 512,
    };
    render(
      <SprayLoupeViewportContext.Provider value={viewport}>
        <SprayHoldSvgLayer {...layerProps} />
      </SprayLoupeViewportContext.Provider>,
    );
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
    observed.deferJS = true;
    viewport.centerXSV.value = 400;
    flushReactions();
    expect(viewport.readySV.value).toBe(false);
    viewport.centerXSV.value = 100;
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
    act(() => {
      for (const callback of observed.pendingJS.splice(0)) callback();
    });
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
  });

  it('an adjacent cell remains visible without a JS render', () => {
    const layerProps = props(wall(1500));
    const viewport: SprayLoupeViewport = {
      centerXSV: shared(100),
      centerYSV: shared(100),
      magnificationSV: shared(4),
      readySV: shared(false),
      renderWidth: 512,
      renderHeight: 512,
    };
    render(
      <SprayLoupeViewportContext.Provider value={viewport}>
        <SprayHoldSvgLayer {...layerProps} />
      </SprayLoupeViewportContext.Provider>,
    );
    flushReactions();
    observed.pathUpdates = [];
    observed.deferJS = true;
    viewport.centerXSV.value = 150;
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
    expect(observed.pendingJS.length).toBeGreaterThan(0);
    expect(observed.pathUpdates).toHaveLength(0);
  });

  it('a first UI reaction after the cell commits cannot hide the loupe', () => {
    const layerProps = props(wall(50));
    const viewport: SprayLoupeViewport = {
      centerXSV: shared(100),
      centerYSV: shared(100),
      magnificationSV: shared(4),
      readySV: shared(false),
      renderWidth: 512,
      renderHeight: 512,
    };
    render(
      <SprayLoupeViewportContext.Provider value={viewport}>
        <SprayHoldSvgLayer {...layerProps} />
      </SprayLoupeViewportContext.Provider>,
    );
    flushReactions();
    for (const record of observed.reactions) record.previous = null;
    flushReactions();
    expect(viewport.readySV.value).toBe(true);
  });
});

describe('inactive loupe artwork', () => {
  function mountLoupe() {
    const feed = {
      touchDownAtSV: shared(0),
      xSV: shared(100),
      ySV: shared(200),
      renderXSV: shared(100),
      renderYSV: shared(100),
      zoomSV: shared(2),
    };
    const view = render(
      <SprayLoupe
        feed={feed}
        magnificationSV={shared(4)}
        clipOffsetX={0}
        clipOffsetY={0}
        hostWidth={512}
        hostHeight={600}
        topSafe={0}
        renderWidth={512}
        renderHeight={512}
      >
        <SprayHoldSvgLayer {...props(wall(530))} />
      </SprayLoupe>,
    );
    const opacity = observed.sharedValues[0] as { value: number };
    return { view, opacity, feed };
  }

  it('Pencil/idle input retains no hidden native artwork', () => {
    const { view } = mountLoupe();
    flushReactions();
    expect(view.queryAllByTestId('canvas')).toHaveLength(0);
  });

  it('a quick finger tap does not mount artwork during the loupe delay', () => {
    const { view, feed } = mountLoupe();
    feed.touchDownAtSV.value = Date.now();
    flushReactions();
    feed.touchDownAtSV.value = 0;
    flushReactions();
    expect(view.queryAllByTestId('canvas')).toHaveLength(0);
  });

  it('keeps art through fade-out, then releases both canvases at zero opacity', () => {
    const { view, opacity } = mountLoupe();
    opacity.value = 0.2;
    flushReactions();
    flushReactions();
    expect(view.queryAllByTestId('canvas')).toHaveLength(2);
    opacity.value = 0.1;
    flushReactions();
    expect(view.queryAllByTestId('canvas')).toHaveLength(2);
    opacity.value = 0;
    flushReactions();
    expect(view.queryAllByTestId('canvas')).toHaveLength(0);
  });

  it('a queued fade-out cannot release a new visible gesture', () => {
    const { view, opacity } = mountLoupe();
    opacity.value = 0.2;
    flushReactions();
    flushReactions();
    observed.deferJS = true;
    opacity.value = 0;
    flushReactions();
    opacity.value = 0.3;
    flushReactions();
    act(() => {
      for (const callback of observed.pendingJS.splice(0)) callback();
    });
    expect(view.queryAllByTestId('canvas')).toHaveLength(2);
  });
});
