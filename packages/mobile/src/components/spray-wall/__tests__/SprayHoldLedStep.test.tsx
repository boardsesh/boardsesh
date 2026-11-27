// @vitest-environment jsdom
import { createElement, useState, type ReactElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSprayLedMapping,
  createLedStripes,
  DEFAULT_TNUT_CORNERS,
  type TnutLayout,
  type SprayLedLinkLayer,
} from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';

const preview = vi.hoisted(() => ({
  available: true,
  error: null as string | null,
  stop: vi.fn(),
  show: vi.fn(),
}));
const canvas = vi.hoisted(() => ({
  current: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null,
  rail: null as ReactNode,
}));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({
    canvas: props,
    fullScreenRail,
  }: {
    canvas: typeof canvas.current;
    fullScreenRail: ReactNode;
  }) => {
    canvas.current = props;
    canvas.rail = fullScreenRail;
    return null;
  },
}));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null }));
vi.mock('../SprayPointToolbar', () => ({
  SprayPhotoToolButton: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress }, label),
  SprayUndoButton: ({ disabled, onPress }: { disabled: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress, 'data-icon': 'undo' }, 'sprayLedSetup.undo'),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: { key: string; label: string }[];
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key) }, option.label),
      ),
    ),
}));
vi.mock('../../../lib/spray/use-spray-led-preview', () => ({ useSprayLedPreview: () => preview }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; linked?: number; total?: number }) => {
      if (options?.total !== undefined) return `${key}:${options.linked}/${options.total}`;
      return options?.count === undefined ? key : `${key}:${options.count}`;
    },
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: [0, 4, 8, 12], brandColors: { error: '#900' } }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { SprayHoldLedStep } from '../SprayHoldLedStep';

const left = { x: 0.2, y: 0.3 };
const right = { x: 0.8, y: 0.3 };
const initial: TnutLayout = {
  version: 1,
  photoKey: 'frame',
  pattern: 'grid',
  rows: 2,
  columns: 2,
  corners: DEFAULT_TNUT_CORNERS,
  firstRowOffset: false,
  ledPlacement: 'sides',
  holes: [left, right],
  ledPositions: [
    { id: 'a', x: 0.19, y: 0.3, hole: left },
    { id: 'b', x: 0.21, y: 0.3, hole: left },
    { id: 'c', x: 0.8, y: 0.3, hole: right },
  ],
  wiring: { direction: 'custom', startCorner: 'tl', paths: [['a', 'b', 'c']], skips: [] },
};
const source: SprayLookPreviewSource = {
  layoutId: 12,
  versionId: 34,
  photoUrl: 'https://example.com/photo',
  photoExpiresAt: '',
  photo: { width: 1000, height: 1400 },
  frame: { width: 500, height: 700 },
  homography: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1],
  holds: [],
};
// Hold 10 covers the left hole (LEDs a, b = 0, 1); hold 20 the right one (LED c = 2).
const holds = [
  { id: 10, cx: 100, cy: 210, r: 35 },
  { id: 20, cx: 400, cy: 210, r: 35 },
];
const changes: Partial<TnutLayout>[] = [];
function Harness({
  start = initial,
  wallHolds = holds,
  wallSource = source,
  layer = 'primary',
}: {
  start?: TnutLayout;
  wallHolds?: typeof holds;
  wallSource?: SprayLookPreviewSource;
  layer?: SprayLedLinkLayer;
}) {
  const [layout, setLayout] = useState(start);
  return (
    <SprayHoldLedStep
      wallUuid="wall"
      layout={layout}
      holds={wallHolds}
      source={wallSource}
      photoUri="file:///photo"
      width={400}
      layer={layer}
      onChange={(update) => {
        changes.push(update);
        setLayout((previous) => ({ ...previous, ...update }));
      }}
      onInteractionChange={vi.fn()}
    />
  );
}
function tap(point: { x: number; y: number }) {
  act(() => canvas.current?.onTap?.(point, 500, 700));
}
function overlay() {
  const renderOverlay = canvas.current?.renderOverlay;
  if (!renderOverlay) throw new Error('No overlay');
  const element = renderOverlay(
    500,
    700,
    { value: 1 } as never,
    { value: 0 } as never,
    { value: 0 } as never,
    { value: null } as never,
  ) as ReactElement<{
    selected: string[];
    selectedHoldIds: number[];
    holdRings: { id: number }[];
    unmappedHoldIds: number[];
    unmappedHoles: { id: string }[];
    holes: { x: number; y: number }[];
    mutedHoles: { x: number; y: number }[];
    selectedHoles: { x: number; y: number }[];
    associations: { from: { x: number; y: number }; to: { id: string } }[];
  }>;
  return element.props;
}
const button = (name: string) => screen.getByText(`sprayLedSetup.${name}`) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  changes.length = 0;
  preview.available = true;
  preview.error = null;
});
afterEach(cleanup);

describe('holds and LEDs step', () => {
  it('counts and cycles only holds centred on the photo within the calibrated crop', () => {
    render(
      <Harness
        wallSource={{ ...source, homography: [0.5, 0, 50, 0, 0.5, 0, 0, 0, 1] }}
        wallHolds={[
          ...holds,
          { id: 30, cx: -20, cy: 500, r: 30 },
          { id: 40, cx: 20, cy: 100, r: 35 },
          { id: 50, cx: 490, cy: 500, r: 30 },
        ]}
      />,
    );
    expect(overlay().holdRings.map((ring) => ring.id)).toEqual([10, 20, 50]);
    expect(screen.getByText('sprayLedSetup.holdLedsSummary:2/3')).toBeTruthy();
    expect(overlay().unmappedHoldIds).toEqual([50]);
    tap({ x: 0.04, y: 100 / 700 });
    expect(overlay().selectedHoldIds).toEqual([]);
    fireEvent.click(button('holdLedsNextUnmapped'));
    expect(overlay().selectedHoldIds).toEqual([50]);
  });

  it('shows a lighting error and retries only on an explicit selection or retry press', () => {
    const rendered = render(<Harness />);
    expect(preview.show).not.toHaveBeenCalled();
    tap(left);
    expect(preview.show).toHaveBeenCalledTimes(1);
    preview.error = 'unavailable';
    rendered.rerender(<Harness />);
    expect(screen.getByText('sprayLed.lightFailed')).toBeTruthy();
    expect(preview.show).toHaveBeenCalledTimes(1);
    fireEvent.click(button('retry'));
    expect(preview.show).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('sprayLedSetup.holdLedsPickHolds'));
    tap(left);
    expect(preview.show).toHaveBeenCalledTimes(3);
    preview.available = false;
    rendered.rerender(<Harness />);
    preview.available = true;
    rendered.rerender(<Harness />);
    expect(preview.show).toHaveBeenCalledTimes(3);
  });

  it('shows and lights a tapped hold, then links an LED to it by hand', () => {
    render(<Harness />);
    expect(screen.getByText('sprayLedSetup.holdLedsNoHold')).toBeTruthy();
    expect(button('holdLedsNextUnmapped').disabled).toBe(true);
    tap(left);
    expect(overlay().selectedHoldIds).toEqual([10]);
    expect(overlay().selected).toEqual(['a', 'b']);
    expect(preview.show).toHaveBeenLastCalledWith([0, 1]);
    expect(screen.getByText('sprayLedSetup.holdLedsSelected:2')).toBeTruthy();
    // Picking a hold moves on to its LEDs: tapping LED c adds it to hold 10.
    tap(right);
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: left, ledIds: ['a', 'b', 'c'] }] });
    expect(preview.show).toHaveBeenLastCalledWith([0, 1, 2]);
    expect(screen.getByText('sprayLedSetup.holdLedsSelectedManual:3')).toBeTruthy();
    // LED c left hold 20, which now has no LED.
    expect(overlay().unmappedHoldIds).toEqual([20]);
    // Tapping it again takes it away.
    tap(right);
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: left, ledIds: ['a', 'b'] }] });
  });

  it('jumps to holds without LEDs, and undoes and resets hand-made links', () => {
    render(<Harness />);
    tap(left);
    tap(right);
    fireEvent.click(button('holdLedsNextUnmapped'));
    expect(overlay().selectedHoldIds).toEqual([20]);
    expect(preview.stop).toHaveBeenCalled();
    fireEvent.click(button('undo'));
    expect(changes.at(-1)).toEqual({ holdLeds: [], holdAboveLeds: [], tnutLeds: [] });
    expect(overlay().unmappedHoldIds).toEqual([]);
    expect(button('undo').disabled).toBe(true);
    // Back on hold 10, a hand-made link can be given back to the automatic mapping.
    fireEvent.click(screen.getByText('sprayLedSetup.holdLedsPickHolds'));
    tap(left);
    expect(button('holdLedsReset').disabled).toBe(true);
    tap({ x: 0.19, y: 0.3 });
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: left, ledIds: [] }] });
    expect(button('holdLedsReset').disabled).toBe(false);
    fireEvent.click(button('holdLedsReset'));
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [] });
    expect(overlay().selected).toEqual(['a', 'b']);
  });

  it('before the cable, counts LED positions as linked and says the wall lights up later', () => {
    function Unwired() {
      const [layout, setLayout] = useState<TnutLayout>({ ...initial, wiring: undefined });
      return (
        <SprayHoldLedStep
          wallUuid="wall"
          layout={layout}
          holds={holds}
          source={source}
          photoUri="file:///photo"
          width={400}
          onChange={(update) => setLayout((previous) => ({ ...previous, ...update }))}
          onInteractionChange={vi.fn()}
        />
      );
    }
    render(<Unwired />);
    expect(screen.getByText('sprayLedSetup.holdLedsNotWired')).toBeTruthy();
    expect(overlay().unmappedHoldIds).toEqual([]);
    tap(left);
    expect(overlay().selected).toEqual(['a', 'b']);
    // No physical LED numbers yet, so nothing lights.
    expect(preview.show).not.toHaveBeenCalled();
    tap(right);
    expect(overlay().unmappedHoldIds).toEqual([20]);
  });

  it('steps to an LED without a hold, lights it, and adds it to the hold tapped next', () => {
    // LED d sits between the holds, so the photo gives it to neither.
    const loose = { id: 'd', x: 0.5, y: 0.6 };
    render(
      <Harness
        start={{
          ...initial,
          ledPositions: [...(initial.ledPositions ?? []), loose],
          wiring: { direction: 'custom', startCorner: 'tl', paths: [['a', 'b', 'c', 'd']], skips: [] },
        }}
      />,
    );
    expect(overlay().unmappedHoles.map((led) => led.id)).toEqual(['d']);
    fireEvent.click(button('holdLedsNextFreeLed'));
    expect(overlay().selected).toEqual(['d']);
    expect(overlay().selectedHoldIds).toEqual([]);
    expect(preview.show).toHaveBeenLastCalledWith([3]);
    expect(screen.getByText('sprayLedSetup.holdLedsFreeLedSelected')).toBeTruthy();
    // Tapping hold 20 adds d to the LED it already had.
    tap(right);
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: right, ledIds: ['c', 'd'] }] });
    expect(overlay().selectedHoldIds).toEqual([20]);
    expect(overlay().unmappedHoles).toEqual([]);
    expect(button('holdLedsNextFreeLed').disabled).toBe(true);
    expect(preview.show).toHaveBeenLastCalledWith([2, 3]);
  });

  const pairAndSingle: TnutLayout = {
    ...initial,
    ledPositions: [
      ...initial.ledPositions!,
      { id: 'd', x: 0.4, y: 0.6 },
      { id: 'e', x: 0.5, y: 0.6 },
      { id: 'f', x: 0.6, y: 0.6 },
    ],
    ledGroups: [
      ['a', 'b'],
      ['d', 'e'],
    ],
    wiring: { direction: 'custom', startCorner: 'tl', paths: [['a', 'b', 'c', 'd', 'e', 'f']], skips: [] },
  };

  it('cycles a free pair once, lights both LEDs and assigns both in one edit', () => {
    render(<Harness start={pairAndSingle} />);
    fireEvent.click(button('holdLedsNextFreeLed'));
    expect(overlay().selected).toEqual(['d', 'e']);
    expect(preview.show).toHaveBeenLastCalledWith([3, 4]);
    expect(screen.getByText('sprayLedSetup.holdLedsFreePairSelected')).toBeTruthy();

    fireEvent.click(button('holdLedsNextFreeLed'));
    expect(overlay().selected).toEqual(['f']);
    fireEvent.click(button('holdLedsNextFreeLed'));
    expect(overlay().selected).toEqual(['d', 'e']);

    tap(right);
    expect(changes).toHaveLength(1);
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: right, ledIds: ['c', 'd', 'e'] }] });
    expect(overlay().unmappedHoles.map((led) => led.id)).toEqual(['f']);
  });

  it('finds a partly linked pair without transferring the already assigned LED', () => {
    render(<Harness start={{ ...pairAndSingle, holdLeds: [{ holdId: 10, ledIds: ['a', 'b', 'd'] }] }} />);
    fireEvent.click(button('holdLedsNextFreeLed'));
    expect(overlay().selected).toEqual(['d', 'e']);
    expect(preview.show).toHaveBeenLastCalledWith([3, 4]);
    tap(right);
    expect(changes.at(-1)).toMatchObject({
      holdLeds: [{ holdId: 10, ledIds: ['a', 'b', 'd'] }],
      tnutLeds: [{ hole: right, ledIds: ['c', 'e'] }],
    });
  });

  it('picks another hold when a tap in LED mode misses every LED', () => {
    render(<Harness />);
    tap(left);
    // Far from any LED but inside hold 20's circle.
    tap({ x: 0.8, y: 0.34 });
    expect(overlay().selectedHoldIds).toEqual([20]);
    expect(changes).toEqual([]);
  });

  it('keeps mounted nuts selectable and changes their hold with multiple LEDs', () => {
    render(<Harness start={{ ...initial, ledPlacement: 'center' }} />);
    fireEvent.click(button('holdLedsPickTnuts'));
    expect(overlay().holes).toEqual([left, right]);
    expect(overlay().mutedHoles).toEqual([left, right]);
    tap(left);
    expect(overlay().selectedHoles).toEqual([left]);
    tap(right); // The LED overlaps another nut; the active target keeps the edit.
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: left, ledIds: ['a', 'b', 'c'] }] });
    expect(overlay().selectedHoles).toEqual([left]);
    expect(overlay().selected).toEqual(['a', 'b', 'c']);
    fireEvent.click(button('holdLedsChooseTnut'));
    tap(right);
    expect(overlay().selectedHoles).toEqual([right]);
    expect(overlay().selected).toEqual([]);
    expect(button('holdLedsNextTnut').disabled).toBe(false);
    tap({ x: 0.5, y: 0.9 });
    expect(overlay().selectedHoles).toEqual([]);
  });

  it('counts and fixes empty nuts, including an unmounted nut', () => {
    const emptyNut = { x: 0.5, y: 0.8 };
    render(<Harness start={{ ...initial, holes: [...initial.holes, emptyNut] }} />);
    fireEvent.click(button('holdLedsPickTnuts'));
    expect(screen.getByText('sprayLedSetup.holdLedsTnutSummary:2/3')).toBeTruthy();
    fireEvent.click(button('holdLedsNextTnut'));
    expect(overlay().selectedHoles).toEqual([emptyNut]);
    tap(right);
    expect(changes.at(-1)).toMatchObject({ tnutLeds: [{ hole: emptyNut, ledIds: ['c'] }] });
    expect(preview.show).toHaveBeenLastCalledWith([2]);
  });

  it('shows effective legacy links and edits, resets and undoes their nut migration atomically', () => {
    const legacy = [{ holdId: 10, ledIds: ['a', 'b', 'c'] }];
    render(<Harness start={{ ...initial, holdLeds: legacy }} />);
    fireEvent.click(button('holdLedsPickTnuts'));
    tap(left);
    expect(overlay().selected).toEqual(['a', 'b', 'c']);
    tap(right);
    expect(changes.at(-1)).toEqual({ holdLeds: [], holdAboveLeds: [], tnutLeds: [{ hole: left, ledIds: ['a', 'b'] }] });
    fireEvent.click(button('undo'));
    expect(changes.at(-1)).toEqual({ holdLeds: legacy, holdAboveLeds: [], tnutLeds: [] });
    expect(overlay().selected).toEqual(['a', 'b', 'c']);
    fireEvent.click(button('holdLedsReset'));
    expect(changes.at(-1)).toEqual({ holdLeds: [], holdAboveLeds: [], tnutLeds: [] });
    expect(overlay().selected).toEqual(['a', 'b']);
  });

  it('edits and previews only upper LEDs, keeping primary links and paired units', () => {
    render(
      <Harness
        layer="above"
        start={{
          ...initial,
          ledPlacement: 'below',
          ledGroups: [['a', 'b']],
          tnutLeds: [
            { hole: left, ledIds: ['c'], aboveLedIds: ['a', 'b'] },
            { hole: right, ledIds: [], aboveLedIds: [] },
          ],
        }}
      />,
    );
    tap(left);
    expect(overlay().selected).toEqual(['a', 'b']);
    expect(preview.show).toHaveBeenLastCalledWith([0, 1]);
    tap({ x: 0.19, y: 0.3 });
    expect(changes.at(-1)?.tnutLeds).toContainEqual({ hole: left, ledIds: ['c'], aboveLedIds: [] });
    expect(overlay().selected).toEqual([]);
    expect(preview.stop).toHaveBeenCalled();
    expect(overlay().unmappedHoldIds).toEqual([10, 20]);
    fireEvent.click(button('undo'));
    expect(overlay().selected).toEqual(['a', 'b']);
  });

  it('keeps reverse pair selection in nut mode, using only free members on the active layer', () => {
    render(
      <Harness
        layer="above"
        start={{
          ...pairAndSingle,
          ledPlacement: 'below',
          tnutLeds: [
            { hole: left, ledIds: ['d', 'e'], aboveLedIds: ['a', 'b', 'c', 'd', 'f'] },
            { hole: right, aboveLedIds: [] },
          ],
        }}
      />,
    );
    fireEvent.click(button('holdLedsPickTnuts'));
    fireEvent.click(button('holdLedsNextFreeTnutLed'));
    expect(overlay().selected).toEqual(['d', 'e']);
    expect(preview.show).toHaveBeenLastCalledWith([3, 4]);
    tap(right);
    expect(changes.at(-1)?.tnutLeds).toContainEqual({ hole: right, aboveLedIds: ['e'] });
    expect(changes.at(-1)?.tnutLeds).toContainEqual({
      hole: left,
      ledIds: ['d', 'e'],
      aboveLedIds: ['a', 'b', 'c', 'd', 'f'],
    });
  });

  it('draws role links and exposes the same target, reverse picker and icon undo in fullscreen', () => {
    render(<Harness />);
    expect(overlay().associations.map((link) => link.to.id)).toEqual(['a', 'b', 'c']);
    const rail = render(createElement('div', null, canvas.rail));
    fireEvent.click(within(rail.container).getByText('sprayLedSetup.holdLedsPickTnuts'));
    tap(left);
    tap(right);
    rail.rerender(createElement('div', null, canvas.rail));
    expect(within(rail.container).getByText('sprayLedSetup.undo').getAttribute('data-icon')).toBe('undo');
    fireEvent.click(within(rail.container).getByText('sprayLedSetup.undo'));
    expect(changes.at(-1)?.tnutLeds).toEqual([]);
  });

  it('edits all covered nuts without copying the whole hold’s LEDs onto the first nut', () => {
    const broadHold = [{ id: 10, cx: 250, cy: 210, r: 180 }];
    render(<Harness wallHolds={broadHold} />);
    tap(left);
    expect(overlay().selected).toEqual(['a', 'b', 'c']);
    tap(right); // Remove c from the whole hold.
    const updated = { ...initial, ...changes.at(-1) };
    const replacement = buildSprayLedMapping(updated, source.frame, holds);
    expect(replacement.holds.find((hold) => hold.holdId === 10)?.ledIds).toEqual(['a', 'b']);
    expect(replacement.holds.find((hold) => hold.holdId === 20)?.ledIds).toEqual([]);
    fireEvent.click(button('holdLedsPickTnuts'));
    tap(right);
    expect(overlay().selected).toEqual([]);
    tap({ x: 0.19, y: 0.3 }); // Explicitly assign the pair only to this nut.
    fireEvent.click(button('holdLedsChooseTnut'));
    tap(left);
    expect(overlay().selected).toEqual(['a', 'b']);
    fireEvent.click(button('undo'));
    expect(overlay().selected).toEqual(['a', 'b']);
    fireEvent.click(button('holdLedsPickHolds'));
    tap(left);
    fireEvent.click(button('holdLedsReset'));
    expect(changes.at(-1)?.tnutLeds).toEqual([]);
  });

  it('keeps sibling nut choices while editing and resetting one nut of a large hold', () => {
    const broadHold = [{ id: 10, cx: 250, cy: 210, r: 180 }];
    const roles = [
      { hole: left, ledIds: ['a'], aboveLedIds: ['c'] },
      { hole: right, ledIds: ['b', 'c'], aboveLedIds: [] },
    ];
    render(<Harness wallHolds={broadHold} start={{ ...initial, ledGroups: [], tnutLeds: roles }} />);
    fireEvent.click(button('holdLedsPickTnuts'));
    tap(left);
    expect(overlay().selected).toEqual(['a']);
    tap({ x: 0.21, y: 0.3 });
    expect(changes.at(-1)?.tnutLeds).toContainEqual(roles[1]);
    expect(changes.at(-1)?.tnutLeds).toContainEqual({ ...roles[0], ledIds: ['a', 'b'] });
    fireEvent.click(button('undo'));
    expect(changes.at(-1)?.tnutLeds).toEqual(roles);
    fireEvent.click(button('holdLedsReset'));
    expect(changes.at(-1)?.tnutLeds).toContainEqual(roles[1]);
    expect(changes.at(-1)?.tnutLeds).toContainEqual({ hole: left, aboveLedIds: ['c'] });
  });

  it('keeps more than 64 automatically mapped strip LEDs when one member is removed', () => {
    const stripe = createLedStripes(
      {
        ...initial,
        rows: 2,
        columns: 1,
        corners: {
          topLeft: { x: 0.5, y: 0.1 },
          topRight: { x: 0.5, y: 0.1 },
          bottomLeft: { x: 0.5, y: 0.9 },
          bottomRight: { x: 0.5, y: 0.9 },
        },
        holes: [
          { x: 0.5, y: 0.3 },
          { x: 0.5, y: 0.7 },
        ],
        ledGroups: [],
      },
      'vertical',
      100,
    );
    if (stripe === 'capacity') throw new Error('fixture capacity');
    const wallHold = [{ id: 10, cx: 250, cy: 350, r: 200 }];
    const wired = {
      ...stripe,
      wiring: {
        direction: 'custom' as const,
        startCorner: 'tl' as const,
        paths: [stripe.ledStripes!.stripes[0].ledIds],
        skips: [],
      },
    };
    render(<Harness start={wired} wallHolds={wallHold} />);
    tap({ x: 0.5, y: 0.5 });
    const before = overlay().selected;
    expect(before.length).toBeGreaterThan(64);
    const led = stripe.ledPositions!.find((position) => position.id === before[0])!;
    tap(led);
    expect(overlay().selected).toHaveLength(before.length - 1);
    expect(overlay().selected).toEqual(before.filter((id) => id !== led.id));
    expect(preview.show).toHaveBeenLastCalledWith(expect.arrayContaining([98, 99]));
    fireEvent.click(button('undo'));
    expect(overlay().selected).toEqual(before);
  });
});
