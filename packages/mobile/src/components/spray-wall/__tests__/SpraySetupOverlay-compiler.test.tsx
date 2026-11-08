// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { compileFunction, createContext } from 'node:vm';
import * as React from 'react';
import * as compilerRuntime from 'react/compiler-runtime';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedPosition, TnutPoint, TnutWiring } from '@boardsesh/spray-wall-geometry';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(require.resolve('@expo/cli/package.json'));
const babel = cliRequire('@babel/core') as {
  transformSync: (source: string, options: Record<string, unknown>) => { code?: string | null } | null;
};
const mobileRoot = dirname(require.resolve('../../../../package.json'));
const componentFile = require.resolve('../SpraySetupOverlay.tsx');
type UiProps = { d?: string; strokeWidth?: number };
type Worklet = (() => UiProps) & {
  __workletHash?: number;
  __initData?: { code: string };
  __closure?: Record<string, unknown> | unknown[];
};
type Shape = {
  d?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  animatedProps: { updater: Worklet };
};
type OverlayProps = {
  holes: TnutPoint[];
  leds: LedPosition[];
  wiring: TnutWiring;
  selected: string[];
  width: number;
  height: number;
  zoom: { value: number };
  panX: { value: number };
  panY: { value: number };
  holdRings?: { id: number; points: TnutPoint[] }[];
  selectedHoldIds?: number[];
  selectedHoles?: TnutPoint[];
};
const palette = { primary: '#7b2fce', warning: '#ef950a', error: '#d22', onPrimary: '#fff' };

/** Rebuild serialized worklets in a separate VM, never call their JS closures.
 * A normal function captured by React Compiler is a remote JS function on the
 * native UI runtime. Reject it instead of letting a plain Vitest mock hide it.
 */
function runOnUi(updater: Worklet): UiProps {
  const uiContext = createContext({ _WORKLET: true });
  const clone = (captured: unknown): unknown => {
    if (typeof captured === 'function') {
      const worklet = captured as Worklet;
      if (typeof worklet.__workletHash !== 'number' || !worklet.__initData?.code)
        throw new Error(`Remote JS function captured by UI worklet: ${captured.name}`);
      const closure = clone(worklet.__closure ?? {});
      const rebuilt = compileFunction(`return (${worklet.__initData.code});`, [], { parsingContext: uiContext })() as (
        ...args: unknown[]
      ) => unknown;
      return (...args: unknown[]) => rebuilt.apply({ __closure: closure }, args);
    }
    if (Array.isArray(captured)) return captured.map(clone);
    if (captured && typeof captured === 'object')
      return Object.fromEntries(Object.entries(captured).map(([name, entry]) => [name, clone(entry)]));
    return captured;
  };
  return (clone(updater) as () => UiProps)();
}

function compileOverlay(source: string, isDev: boolean) {
  const compiled = babel.transformSync(source, {
    cwd: mobileRoot,
    filename: componentFile,
    configFile: false,
    babelrc: false,
    caller: {
      name: 'metro',
      bundler: 'metro',
      platform: 'android',
      engine: 'hermes',
      isDev,
      isServer: false,
      isNodeModule: false,
      supportsReactCompiler: true,
      supportsStaticESM: false,
    },
    presets: [expoRequire.resolve('babel-preset-expo')],
  });
  if (!compiled?.code) throw new Error('Expo produced no overlay code');
  // Both compiler stages must actually run; a silently disabled Worklets plugin
  // would make the test no more useful than the original useAnimatedProps mock.
  expect(compiled.code).toContain('__workletHash');
  expect(compiled.code).toContain('react/compiler-runtime');
  const shapes: Shape[] = [];
  const Path = (props: Shape) => {
    shapes.push(props);
    return null;
  };
  const Svg = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  const imports: Record<string, unknown> = {
    react: React,
    'react/compiler-runtime': compilerRuntime,
    'react/jsx-runtime': jsxRuntime,
    'react/jsx-dev-runtime': jsxDevRuntime,
    'react-native': { StyleSheet: { absoluteFill: {} } },
    'react-native-svg': { __esModule: true, default: Svg, Path },
    'react-native-reanimated': {
      __esModule: true,
      default: { createAnimatedComponent: () => Path },
      useAnimatedProps: (updater: Worklet) => ({ updater }),
    },
    '../../providers/theme-provider': { useTheme: () => ({ brandColors: palette }) },
  };
  const module = { exports: {} as Record<string, unknown> };
  compileFunction(compiled.code, ['require', 'module', 'exports', '__DEV__'])(
    (specifier: string) => {
      if (specifier in imports) return imports[specifier];
      if (specifier.startsWith('@babel/runtime/')) return cliRequire(specifier);
      throw new Error(`Unexpected compiled overlay import: ${specifier}`);
    },
    module,
    module.exports,
    isDev,
  );
  return { Component: module.exports.SpraySetupOverlay as React.ComponentType<OverlayProps>, shapes };
}

const previousGapUpdater = `
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
const AnimatedPath = Animated.createAnimatedComponent(Path);
export function SpraySetupOverlay({ leds: edges, width, height, zoom }) {
  const gapProps = useAnimatedProps(() => ({
    d: edges.filter((edge) => edge.gap).map(({ from, to }) => {
      const x = ((from.x + to.x) * width) / 2;
      const y = ((from.y + to.y) * height) / 2;
      const size = 5 / zoom.value;
      return 'M' + (x-size) + ' ' + y + 'L' + x + ' ' + (y-size);
    }).join(''),
    strokeWidth: 1.5 / zoom.value,
  }));
  return <Svg><AnimatedPath animatedProps={gapProps} /></Svg>;
}`;

function props(): OverlayProps {
  return {
    holes: [{ x: 0.1, y: 0.2 }],
    leds: [
      { id: 'a', x: 0.2, y: 0.3 },
      { id: 'b', x: 0.6, y: 0.3 },
      { id: 'c', x: 0.6, y: 0.8 },
    ],
    wiring: {
      direction: 'horizontal',
      startCorner: 'tl',
      paths: [['a', 'b', 'c']],
      skips: [{ from: 'b', to: 'c', count: 2 }],
    },
    selected: ['b'],
    width: 300,
    height: 500,
    zoom: { value: 1 },
    panX: { value: 0 },
    panY: { value: 0 },
  };
}
function evaluated(shapes: Shape[]) {
  return shapes.map((shape) => ({ ...shape, ...runOnUi(shape.animatedProps.updater) }));
}
function expectPathCoordinates(path: string | undefined, coordinates: number[]) {
  const actual = path?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  expect(actual).toHaveLength(coordinates.length);
  coordinates.forEach((coordinate, index) => expect(actual?.[index]).toBeCloseTo(coordinate, 8));
}

afterEach(cleanup);

describe.each([true, false])('Expo + React Compiler + native Worklets overlay (dev=%s)', (isDev) => {
  it('detects the original filtered-edge remote-function crash', () => {
    const { Component, shapes } = compileOverlay(previousGapUpdater, isDev);
    render(React.createElement(Component, props()));
    expect(() => evaluated(shapes)).toThrow('Remote JS function captured by UI worklet');
  }, 20000);

  it('executes every serialized updater and keeps marks and cable geometry correct while zooming', () => {
    const { Component, shapes } = compileOverlay(readFileSync(componentFile, 'utf8'), isDev);
    const initial = props();
    render(React.createElement(Component, initial));
    expect(shapes).toHaveLength(7);
    const atOne = evaluated(shapes);
    expect(atOne[0]).toMatchObject({ d: 'M60 150L180 150', stroke: '#0891B2', strokeWidth: 2 });
    expect(atOne[1]).toMatchObject({ d: 'M180 150L180 400', stroke: palette.error });
    expectPathCoordinates(atOne[2].d, [127, 153, 132, 150, 127, 147]);
    expect(atOne[3].d?.match(/M/g)).toHaveLength(2);
    expect(atOne[3].d).toContain(`M177 ${150 + 250 / 3}a3 3`);
    expect(atOne[3].fill).toBe(palette.error);
    expect(atOne[4]).toMatchObject({
      d: 'M27 100a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
      fill: 'none',
      stroke: palette.warning,
    });
    expect(atOne[5].d).toContain('M56 150a4 4');
    expect(atOne[6].d).toBe('M170 150a10 10 0 1 0 20 0a10 10 0 1 0 -20 0');
    initial.zoom.value = 3;
    initial.panY.value = 100;
    const atThree = evaluated(shapes);
    expectPathCoordinates(atThree[0].d, [-120, 50, 240, 50]);
    expect(atThree[0].strokeWidth).toBe(2);
    expect(atThree[4].d).toBe(''); // offscreen holes do not build invisible SVG geometry
    expect(atThree[5].d).toContain('a4 4');
    expect(atThree[6].d).toContain('a10 10');
    expectPathCoordinates(atThree[2].d, [91, 53, 96, 50, 91, 47]);
    expect(atThree[3].d?.match(/M/g)).toHaveLength(1);
    expect(atThree[3].d).toContain('a3 3');
  });

  it('updates compiled closures when holes, LEDs, selection and skip edges change', () => {
    const { Component, shapes } = compileOverlay(readFileSync(componentFile, 'utf8'), isDev);
    const initial = props();
    const view = render(React.createElement(Component, initial));
    shapes.length = 0;
    view.rerender(
      React.createElement(Component, {
        ...initial,
        holes: [{ x: 0.4, y: 0.4 }],
        selected: ['c'],
        leds: initial.leds.map((led) => (led.id === 'c' ? { ...led, x: 0.7 } : led)),
        wiring: { ...initial.wiring, skips: [] },
      }),
    );
    const updated = evaluated(shapes);
    expect(updated[0].d).toBe('M60 150L180 150M180 150L210 400');
    expect(updated[1].d).toBe('');
    expect(updated[3].d).toBe('');
    expect(updated[4].d).toContain('M117 200a3 3');
    expect(updated[6].d).toContain('M200 400a10 10');
  });

  it('serializes selectable hold contours and highlighted holes in the rectified viewport', () => {
    const { Component, shapes } = compileOverlay(readFileSync(componentFile, 'utf8'), isDev);
    const initial = {
      ...props(),
      holdRings: [
        {
          id: 42,
          points: [
            { x: 0.2, y: 0.3 },
            { x: 0.6, y: 0.3 },
            { x: 0.6, y: 0.8 },
          ],
        },
      ],
      selectedHoldIds: [42],
      selectedHoles: [{ x: 0.1, y: 0.2 }],
    };
    render(React.createElement(Component, initial));
    const paths = evaluated(shapes);
    expect(paths).toHaveLength(10);
    expect(paths[7].d).toBe('M60 150L180 150L180 400Z');
    expect(paths[8].d).toBe(paths[7].d);
    expect(paths[9].d).toContain('M19 100a11 11');
    initial.zoom.value = 3;
    initial.panY.value = 100;
    const zoomed = evaluated(shapes);
    expectPathCoordinates(zoomed[7].d, [-120, 50, 240, 50, 240, 800]);
    expect(zoomed[8].strokeWidth).toBe(3);
  });
});
