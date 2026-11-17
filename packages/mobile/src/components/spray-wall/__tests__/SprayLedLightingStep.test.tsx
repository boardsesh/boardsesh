// @vitest-environment jsdom
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';

const preview = vi.hoisted(() => ({
  available: true,
  state: 'idle',
  error: null as string | null,
  allLit: false,
  chaseIndex: null as number | null,
  lightAll: vi.fn(),
  chase: vi.fn(),
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
vi.mock('../SprayPointToolbar', () => ({
  SprayPhotoToolButton: ({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) =>
    createElement('button', { 'aria-pressed': selected, onClick: onPress }, label),
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

import { SprayLedLightingStep } from '../SprayLedLightingStep';

const hole = { x: 0.2, y: 0.3 };
const layout: TnutLayout = {
  version: 1,
  photoKey: 'frame',
  pattern: 'grid',
  rows: 2,
  columns: 2,
  corners: DEFAULT_TNUT_CORNERS,
  firstRowOffset: false,
  ledPlacement: 'sides',
  holes: [hole, { x: 0.8, y: 0.3 }],
  ledPositions: [
    { id: 'a', x: 0.19, y: 0.3, hole },
    { id: 'b', x: 0.21, y: 0.3, hole },
    { id: 'c', x: 0.8, y: 0.3, hole: { x: 0.8, y: 0.3 } },
  ],
  wiring: {
    direction: 'custom',
    startCorner: 'tl',
    paths: [['a', 'b']],
    initialSkip: 2,
    skips: [{ from: 'a', to: 'b', count: 2 }],
  },
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
const props = {
  wallUuid: 'wall',
  orderedIndices: [5, 2, 9],
  layout,
  source,
  holds: [
    { id: 10, cx: 100, cy: 210, r: 35 },
    { id: 20, cx: 400, cy: 210, r: 35 },
  ],
  photoUri: 'file:///cached-photo',
  width: 400,
  onInteractionChange: vi.fn(),
};
function tap(x: number, y: number) {
  act(() => canvas.current?.onTap?.({ x, y }, 500, 700));
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.available = true;
  preview.state = 'idle';
  preview.error = null;
  preview.allLit = false;
  preview.chaseIndex = null;
});
function litOnPhoto() {
  const overlay = canvas.current?.renderOverlay?.(
    500,
    700,
    { value: 1 } as never,
    { value: 0 } as never,
    { value: 0 } as never,
    { value: null } as never,
  ) as ReactElement<{ selected: string[] }>;
  return overlay.props.selected;
}
afterEach(cleanup);

describe('final lighting test', () => {
  it('offers all LEDs, the ordered row chase, and an always reachable stop', () => {
    render(<SprayLedLightingStep {...props} />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightWired'));
    fireEvent.click(screen.getByText('sprayLedSetup.lightingChase'));
    fireEvent.click(screen.getByText('sprayLedSetup.lightingStop'));
    expect(preview.lightAll).toHaveBeenCalledExactlyOnceWith([2, 5]);
    expect(preview.chase).toHaveBeenCalledWith([5, 2]);
    expect(preview.stop).toHaveBeenCalledTimes(1);
  });

  it('clears the selection for Light all without switching the new lights off', () => {
    render(<SprayLedLightingStep {...props} />);
    tap(hole.x, hole.y);
    expect(screen.getByText('sprayLedSetup.selectionSummary:1')).toBeTruthy();
    preview.stop.mockClear();
    fireEvent.click(screen.getByText('sprayLedSetup.lightWired'));
    expect(preview.lightAll).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sprayLedSetup.selectionSummary:0')).toBeTruthy();
    expect(preview.stop).not.toHaveBeenCalled();
  });

  it('tests and highlights wired photo LEDs, leaving skips, unwired and off-photo positions out', () => {
    const wiring = { ...layout.wiring!, paths: [['a', 'b', 'off-photo']] };
    const fixture = {
      ...props,
      orderedIndices: [6, 5, 2],
      source: { ...source, homography: [0.5, 0, 50, 0, 0.5, 0, 0, 0, 1] },
      layout: { ...layout, wiring, ledPositions: [...layout.ledPositions!, { id: 'off-photo', x: 0.02, y: 0.5 }] },
    };
    const view = render(<SprayLedLightingStep {...fixture} />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightWired'));
    expect(preview.lightAll).toHaveBeenCalledExactlyOnceWith([2, 5]);
    preview.allLit = true;
    view.rerender(<SprayLedLightingStep {...fixture} />);
    expect(screen.getByText('sprayLedSetup.allLitSummary:2')).toBeTruthy();
    expect(litOnPhoto()).toEqual(['a', 'b']);
    expect(screen.queryByText('sprayLedSetup.lightWired')).toBeNull();
    fireEvent.click(screen.getByText('sprayLed.turnOff'));
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(preview.lightAll).toHaveBeenCalledTimes(1);
  });

  it('uses selection feedback after a hole lights and stops a pending batch on an unwired tap', () => {
    const view = render(<SprayLedLightingStep {...props} />);
    tap(hole.x, hole.y);
    preview.state = 'lit';
    view.rerender(<SprayLedLightingStep {...props} />);
    expect(screen.getByText('sprayLedSetup.lightingSelected')).toBeTruthy();
    expect(screen.queryByText('sprayLed.lit')).toBeNull();
    fireEvent.click(screen.getByText('sprayLedSetup.lightWired'));
    preview.state = 'sending';
    view.rerender(<SprayLedLightingStep {...props} />);
    tap(0.8, 0.3);
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sprayLedSetup.selectionUnmapped:1')).toBeTruthy();
  });

  it('draws the LED the row-by-row test has reached', () => {
    // Physical LED 5 is "b": two skipped before "a" (2), two more between them.
    preview.chaseIndex = 5;
    render(<SprayLedLightingStep {...props} />);
    expect(litOnPhoto()).toEqual(['b']);
    // An LED that is not on the photo draws nothing.
    preview.chaseIndex = 3;
    cleanup();
    render(<SprayLedLightingStep {...props} />);
    expect(litOnPhoto()).toEqual([]);
  });

  it('shows unavailable controllers and physical range errors without hiding controls', () => {
    preview.available = false;
    preview.error = 'invalid-indices';
    render(<SprayLedLightingStep {...props} orderedIndices={[]} />);
    expect(screen.getByText('sprayLedSetup.lightingUnavailable')).toBeTruthy();
    expect(screen.getByText('sprayLedSetup.lightingRangeError')).toBeTruthy();
    expect(screen.getByText('sprayLedSetup.lightingStop').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('sprayLedSetup.lightWired').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('sprayLedSetup.lightingChase').hasAttribute('disabled')).toBe(true);
  });

  it('lights selected holes by default and only lights them again after re-enabling the bulb', () => {
    render(<SprayLedLightingStep {...props} />);
    expect(screen.getByText('sprayLedSetup.lightingStop').getAttribute('aria-pressed')).toBe('true');
    expect(preview.show).not.toHaveBeenCalled();
    tap(hole.x, hole.y);
    expect(preview.show).toHaveBeenCalledExactlyOnceWith([2, 5]);
    fireEvent.click(screen.getByText('sprayLedSetup.lightingStop'));
    expect(litOnPhoto()).toEqual([]);
    expect(preview.stop).toHaveBeenCalledTimes(1);
    tap(hole.x, hole.y);
    tap(hole.x, hole.y);
    expect(preview.show).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('sprayLedSetup.lightSelection'));
    expect(preview.show).toHaveBeenCalledTimes(2);
    expect(preview.show).toHaveBeenLastCalledWith([2, 5]);
    expect(litOnPhoto()).toEqual(['a', 'b']);
  });

  it('marks holes and holds without a wired LED and fades the LED dots', () => {
    render(<SprayLedLightingStep {...props} />);
    const overlayProps = () => {
      const renderOverlay = canvas.current?.renderOverlay;
      if (!renderOverlay) throw new Error('No overlay');
      const overlay = renderOverlay(
        500,
        700,
        { value: 1 } as never,
        { value: 0 } as never,
        { value: 0 } as never,
        { value: null } as never,
      ) as ReactElement<{ unmappedHoles: unknown[]; unmappedHoldIds: number[]; subtleLeds: boolean }>;
      return overlay.props;
    };
    expect(overlayProps().subtleLeds).toBe(true);
    expect(overlayProps().unmappedHoles).toEqual([{ x: 0.8, y: 0.3 }]);
    fireEvent.click(screen.getByText('sprayLedSetup.selectHolds'));
    expect(overlayProps().unmappedHoldIds).toEqual([20]);
  });

  it.each(['holes', 'holds'] as const)('replaces the previous %s selection and lights only the new match', (kind) => {
    render(
      <SprayLedLightingStep
        {...props}
        layout={{
          ...layout,
          wiring: { ...layout.wiring!, paths: [['a', 'b', 'c']] },
        }}
      />,
    );
    if (kind === 'holds') fireEvent.click(screen.getByText('sprayLedSetup.selectHolds'));
    tap(0.2, 0.3);
    expect(preview.show).toHaveBeenLastCalledWith([2, 5]);
    tap(0.8, 0.3);
    expect(preview.show).toHaveBeenLastCalledWith([6]);
    expect(litOnPhoto()).toEqual(['c']);
    expect(screen.getByText('sprayLedSetup.selectionSummary:1')).toBeTruthy();
    tap(0.8, 0.3);
    expect(litOnPhoto()).toEqual([]);
    expect(screen.getByText('sprayLedSetup.selectionSummary:0')).toBeTruthy();
  });

  it('selects canonical hold contours, clears the selection on switching, and reports unwired positions', () => {
    render(<SprayLedLightingStep {...props} />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectHolds'));
    expect(preview.stop).toHaveBeenCalledTimes(1);
    tap(0.2, 0.3);
    const overlay = canvas.current?.renderOverlay?.(
      500,
      700,
      { value: 1 } as never,
      { value: 0 } as never,
      { value: 0 } as never,
      { value: null } as never,
    ) as ReactElement<{ selectedHoldIds: number[] }>;
    expect(overlay.props.selectedHoldIds).toEqual([10]);
    expect(preview.show).toHaveBeenLastCalledWith([2, 5]);
    tap(0.8, 0.3);
    expect(screen.getByText('sprayLedSetup.selectionUnmapped:1')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayLedSetup.selectHoles'));
    expect(screen.getByText('sprayLedSetup.selectionSummary:0')).toBeTruthy();
  });

  it('ignores blank photo taps and returns no indices for an unassigned hold', () => {
    render(<SprayLedLightingStep {...props} />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectHolds'));
    tap(0.5, 0.8);
    expect(screen.getByText('sprayLedSetup.selectionSummary:0')).toBeTruthy();
    tap(0.8, 0.3);
    expect(screen.getByText('sprayLedSetup.selectionUnmapped:1')).toBeTruthy();
    expect(preview.show).not.toHaveBeenCalled();
  });
});
