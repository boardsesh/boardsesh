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
  orderedIndices: [7, 2, 9],
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
});
afterEach(cleanup);

describe('final lighting test', () => {
  it('offers all LEDs, the ordered row chase, and an always reachable stop', () => {
    render(<SprayLedLightingStep {...props} />);
    fireEvent.click(screen.getByText('sprayLed.lightAll'));
    fireEvent.click(screen.getByText('sprayLedSetup.lightingChase'));
    fireEvent.click(screen.getByText('sprayLedSetup.lightingStop'));
    expect(preview.lightAll).toHaveBeenCalledTimes(1);
    expect(preview.chase).toHaveBeenCalledWith([7, 2, 9]);
    expect(preview.stop).toHaveBeenCalledTimes(1);
  });

  it('shows unavailable controllers and physical range errors without hiding controls', () => {
    preview.available = false;
    preview.error = 'invalid-indices';
    render(<SprayLedLightingStep {...props} orderedIndices={[]} />);
    expect(screen.getByText('sprayLedSetup.lightingUnavailable')).toBeTruthy();
    expect(screen.getByText('sprayLedSetup.lightingRangeError')).toBeTruthy();
    expect(screen.getByText('sprayLedSetup.lightSelection').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('sprayLed.lightAll').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('sprayLedSetup.lightingChase').hasAttribute('disabled')).toBe(true);
  });

  it('starts empty and lights selected holes with physical skips and both behind-hold LEDs', () => {
    render(<SprayLedLightingStep {...props} />);
    const light = screen.getByText('sprayLedSetup.lightSelection');
    expect(light.hasAttribute('disabled')).toBe(true);
    tap(hole.x, hole.y);
    expect(preview.show).not.toHaveBeenCalled();
    fireEvent.click(light);
    expect(preview.show).toHaveBeenLastCalledWith([2, 5]);
    tap(hole.x, hole.y);
    expect(light.hasAttribute('disabled')).toBe(true);
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
    ) as ReactElement<{ selectedHoldIds: number[] }>;
    expect(overlay.props.selectedHoldIds).toEqual([10]);
    fireEvent.click(screen.getByText('sprayLedSetup.lightSelection'));
    expect(preview.show).toHaveBeenLastCalledWith([2, 5]);
    tap(0.8, 0.3);
    expect(screen.getByText('sprayLedSetup.selectionUnmapped:1')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayLedSetup.selectHoles'));
    expect(screen.getByText('sprayLedSetup.lightSelection').hasAttribute('disabled')).toBe(true);
  });

  it('ignores blank photo taps and returns no indices for an unassigned hold', () => {
    render(<SprayLedLightingStep {...props} />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectHolds'));
    tap(0.5, 0.8);
    expect(screen.getByText('sprayLedSetup.lightSelection').hasAttribute('disabled')).toBe(true);
    tap(0.8, 0.3);
    expect(screen.getByText('sprayLedSetup.selectionUnmapped:1')).toBeTruthy();
    expect(screen.getByText('sprayLedSetup.lightSelection').hasAttribute('disabled')).toBe(true);
    expect(preview.show).not.toHaveBeenCalled();
  });
});
