// @vitest-environment jsdom
import { createElement, useState, type ReactElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';

const preview = vi.hoisted(() => ({
  available: true,
  stop: vi.fn(),
  show: vi.fn(),
}));
const canvas = vi.hoisted(() => ({ current: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null }));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({ canvas: props }: { canvas: typeof canvas.current }) => {
    canvas.current = props;
    return null;
  },
}));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null }));
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
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
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
function Harness() {
  const [layout, setLayout] = useState(initial);
  return (
    <SprayHoldLedStep
      wallUuid="wall"
      layout={layout}
      holds={holds}
      source={source}
      photoUri="file:///photo"
      width={400}
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
  ) as ReactElement<{ selected: string[]; selectedHoldIds: number[]; unmappedHoldIds: number[] }>;
  return element.props;
}
const button = (name: string) => screen.getByText(`sprayLedSetup.${name}`) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  changes.length = 0;
  preview.available = true;
});
afterEach(cleanup);

describe('holds and LEDs step', () => {
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
    expect(changes.at(-1)).toEqual({ holdLeds: [{ holdId: 10, ledIds: ['a', 'b', 'c'] }] });
    expect(preview.show).toHaveBeenLastCalledWith([0, 1, 2]);
    expect(screen.getByText('sprayLedSetup.holdLedsSelectedManual:3')).toBeTruthy();
    // LED c left hold 20, which now has no LED.
    expect(overlay().unmappedHoldIds).toEqual([20]);
    // Tapping it again takes it away.
    tap(right);
    expect(changes.at(-1)).toEqual({ holdLeds: [{ holdId: 10, ledIds: ['a', 'b'] }] });
  });

  it('jumps to holds without LEDs, and undoes and resets hand-made links', () => {
    render(<Harness />);
    tap(left);
    tap(right);
    fireEvent.click(button('holdLedsNextUnmapped'));
    expect(overlay().selectedHoldIds).toEqual([20]);
    expect(preview.stop).toHaveBeenCalled();
    fireEvent.click(button('undo'));
    expect(changes.at(-1)).toEqual({ holdLeds: undefined });
    expect(overlay().unmappedHoldIds).toEqual([]);
    expect(button('undo').disabled).toBe(true);
    // Back on hold 10, a hand-made link can be given back to the automatic mapping.
    fireEvent.click(screen.getByText('sprayLedSetup.holdLedsPickHolds'));
    tap(left);
    expect(button('holdLedsReset').disabled).toBe(true);
    tap({ x: 0.19, y: 0.3 });
    expect(changes.at(-1)).toEqual({ holdLeds: [{ holdId: 10, ledIds: ['b'] }] });
    expect(button('holdLedsReset').disabled).toBe(false);
    fireEvent.click(button('holdLedsReset'));
    expect(changes.at(-1)).toEqual({ holdLeds: undefined });
    expect(overlay().selected).toEqual(['a', 'b']);
  });

  it('picks another hold when a tap in LED mode misses every LED', () => {
    render(<Harness />);
    tap(left);
    // Far from any LED but inside hold 20's circle.
    tap({ x: 0.8, y: 0.34 });
    expect(overlay().selectedHoldIds).toEqual([20]);
    expect(changes).toEqual([]);
  });
});
