// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, ledPairs, readTnutLayout, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';

const controls = vi.hoisted(() => ({
  canvas: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null,
  alert: vi.fn(),
  changed: vi.fn(),
  layout: null as TnutLayout | null,
}));
vi.mock('react-native', () => ({
  Alert: { alert: controls.alert },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Modal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: {}, systemColors: {}, spacing: [0, 4, 8, 12, 16] }),
}));
vi.mock('../../../lib/spray/use-spray-led-preview', () => ({
  useSprayLedPreview: () => ({ available: false, show: vi.fn(), stop: vi.fn(), error: null }),
}));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({ canvas }: { canvas: typeof controls.canvas }) => {
    controls.canvas = canvas;
    return null;
  },
}));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null, SPRAY_CABLE_COLOR: '' }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  BuilderTextInput: ({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) =>
    createElement('input', {
      'aria-label': 'skip count',
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../SprayPointToolbar', () => ({
  SprayUndoButton: () => null,
  SprayPointToolbar: ({
    onModeChange,
    onUndo,
    canUndo,
  }: {
    onModeChange: (mode: string) => void;
    onUndo: () => void;
    canUndo: boolean;
  }) =>
    createElement(
      'div',
      null,
      ...['add', 'remove', 'move'].map((mode) =>
        createElement('button', { key: mode, onClick: () => onModeChange(mode) }, mode),
      ),
      createElement('button', { onClick: onUndo, disabled: !canUndo }, 'undo'),
    ),
}));

import { SprayLedMapEditor } from '../SprayLedMapEditor';

const original: TnutLayout = {
  version: 1,
  photoKey: 'frame',
  pattern: 'grid',
  rows: 2,
  columns: 2,
  firstRowOffset: false,
  corners: DEFAULT_TNUT_CORNERS,
  holes: [],
  ledPositions: [
    { id: 'a', x: 0.2, y: 0.2 },
    { id: 'b', x: 0.8, y: 0.8 },
  ],
  wiring: {
    direction: 'custom',
    startCorner: 'tl',
    paths: [['a', 'b']],
    initialSkip: 3,
    skips: [{ from: 'a', to: 'b', count: 4 }],
  },
};
function Editor({ initial = original, kind = 'positions' }: { initial?: TnutLayout; kind?: 'positions' | 'skips' }) {
  const [layout, setLayout] = useState(initial);
  controls.layout = layout;
  return (
    <SprayLedMapEditor
      kind={kind}
      layout={layout}
      onChange={(update) => {
        controls.changed(update);
        setLayout((previous) => ({ ...previous, ...update }));
      }}
      wallUuid="wall"
      source={{ frame: { width: 1000, height: 1000 } } as SprayLookPreviewSource}
      photoUri="file:///photo"
      width={400}
      onInteractionChange={() => undefined}
    />
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  controls.canvas = null;
});
describe('LED position edits with cable work', () => {
  it('does not transfer a removed manual LED link when Add reuses its id, and Undo restores it', () => {
    const linked: TnutLayout = {
      ...original,
      wiring: undefined,
      ledPositions: [{ id: 'manual-0', x: 0.2, y: 0.2 }],
      holdLeds: [{ holdId: 10, ledIds: ['manual-0'] }],
    };
    render(<Editor initial={linked} />);
    fireEvent.click(screen.getByText('remove'));
    act(() => controls.canvas?.onTap?.({ x: 0.2, y: 0.2 }, 400, 400));
    expect(controls.changed.mock.lastCall?.[0].holdLeds).toEqual([{ holdId: 10, ledIds: [] }]);
    fireEvent.click(screen.getByText('add'));
    act(() => controls.canvas?.onTap?.({ x: 0.8, y: 0.8 }, 400, 400));
    expect(controls.changed.mock.lastCall?.[0].ledPositions).toEqual([{ id: 'manual-0', x: 0.8, y: 0.8 }]);
    expect(controls.changed.mock.lastCall?.[0].holdLeds).toEqual([{ holdId: 10, ledIds: [] }]);
    fireEvent.click(screen.getByText('undo'));
    expect(controls.changed.mock.lastCall?.[0].ledPositions).toEqual([]);
    fireEvent.click(screen.getByText('undo'));
    expect(controls.changed.mock.lastCall?.[0]).toEqual(linked);
  });

  it.each(['add', 'remove'] as const)(
    'requires confirmation before %s discards a cable and undo restores it',
    (mode) => {
      render(<Editor />);
      fireEvent.click(screen.getByText(mode));
      act(() => controls.canvas?.onTap?.(mode === 'add' ? { x: 0.5, y: 0.5 } : { x: 0.2, y: 0.2 }, 400, 400));
      expect(controls.changed).not.toHaveBeenCalled();
      expect(controls.alert).toHaveBeenCalledWith(
        'sprayLedSetup.clearCableTitle',
        'sprayLedSetup.clearCableBody',
        expect.any(Array),
      );
      const buttons = controls.alert.mock.calls[0][2] as { style: string; onPress?: () => void }[];
      expect(buttons[0].style).toBe('cancel');
      act(() => buttons[1].onPress?.());
      expect(controls.changed.mock.lastCall?.[0].wiring).toBeUndefined();
      expect(controls.changed.mock.lastCall?.[0].ledPositions).toHaveLength(mode === 'add' ? 3 : 1);
      fireEvent.click(screen.getByText('undo'));
      expect(controls.changed.mock.lastCall?.[0]).toEqual(original);
    },
  );
  it('moves an LED without losing its cable or prompting', () => {
    render(<Editor />);
    fireEvent.click(screen.getByText('move'));
    act(() => controls.canvas?.onMove?.({ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, 400, 400));
    expect(controls.alert).not.toHaveBeenCalled();
    expect(controls.changed.mock.lastCall?.[0]).not.toHaveProperty('wiring');
  });
  it('adds immediately when no cable has been laid', () => {
    render(<Editor initial={{ ...original, wiring: { ...original.wiring!, paths: [], skips: [] } }} />);
    fireEvent.click(screen.getByText('add'));
    act(() => controls.canvas?.onTap?.({ x: 0.5, y: 0.5 }, 400, 400));
    expect(controls.alert).not.toHaveBeenCalled();
    expect(controls.changed).toHaveBeenCalledOnce();
  });
});

describe('LED pairs behind a hold', () => {
  const paired: TnutLayout = {
    ...original,
    wiring: undefined,
    ledPositions: [
      { id: 'a', x: 0.2, y: 0.2 },
      { id: 'b', x: 0.24, y: 0.2 },
      { id: 'c', x: 0.8, y: 0.8 },
    ],
    ledGroups: [['a', 'b']],
  };
  const latest = () => controls.changed.mock.calls.at(-1)?.[0] as Partial<TnutLayout>;

  it('moves and removes both LEDs of a pair as one unit', () => {
    render(<Editor initial={paired} />);
    fireEvent.click(screen.getByText('move'));
    act(() => controls.canvas?.onMove?.({ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.4 }, 1000, 1000));
    expect(latest().ledPositions?.slice(0, 2)).toEqual([
      { id: 'a', x: 0.3, y: 0.4 },
      { id: 'b', x: expect.closeTo(0.34), y: expect.closeTo(0.4) },
    ]);
    fireEvent.click(screen.getByText('remove'));
    act(() => controls.canvas?.onTap?.({ x: 0.3, y: 0.4 }, 1000, 1000));
    expect(latest().ledPositions?.map((led) => led.id)).toEqual(['c']);
  });

  it('stops a pair at the photo edge without changing the space between its LEDs', () => {
    const nearEdge: TnutLayout = {
      ...paired,
      ledPositions: [
        { id: 'a', x: 0.9, y: 0.5 },
        { id: 'b', x: 0.98, y: 0.5 },
        { id: 'c', x: 0.2, y: 0.2 },
      ],
    };
    render(<Editor initial={nearEdge} />);
    fireEvent.click(screen.getByText('move'));
    act(() => controls.canvas?.onMove?.({ x: 0.9, y: 0.5 }, { x: 0.95, y: 0.5 }, 1000, 1000));
    const [first, second] = latest().ledPositions!;
    expect(first.x).toBeCloseTo(0.92);
    expect(second.x).toBeCloseTo(1);
    expect(second.x - first.x).toBeCloseTo(0.08);
    // Dragging back restores the original spacing too.
    act(() => controls.canvas?.onMove?.({ x: first.x, y: 0.5 }, { x: 0.9, y: 0.5 }, 1000, 1000));
    expect(latest().ledPositions?.slice(0, 2)).toEqual([
      { id: 'a', x: expect.closeTo(0.9), y: 0.5 },
      { id: 'b', x: expect.closeTo(0.98), y: 0.5 },
    ]);
  });

  it('separates a pair with one tap and groups two single LEDs with two', () => {
    render(<Editor initial={paired} />);
    fireEvent.click(screen.getByText('sprayLedSetup.pairLeds'));
    expect(screen.getByText('sprayLedSetup.pairLedsHint')).toBeTruthy();
    act(() => controls.canvas?.onTap?.({ x: 0.2, y: 0.2 }, 1000, 1000));
    expect(latest()).toEqual({ ledGroups: [] });
    act(() => controls.canvas?.onTap?.({ x: 0.24, y: 0.2 }, 1000, 1000));
    expect(screen.getByText('sprayLedSetup.pairLedsSecond')).toBeTruthy();
    act(() => controls.canvas?.onTap?.({ x: 0.8, y: 0.8 }, 1000, 1000));
    expect(latest()).toEqual({ ledGroups: [['b', 'c']] });
  });

  it('Undo of the first pair edit brings back the default pairs of a layout that had no list', () => {
    const sides: TnutLayout = {
      ...paired,
      ledPlacement: 'sides',
      ledGroups: undefined,
      ledPositions: [
        { id: 'a', x: 0.2, y: 0.2, hole: { x: 0.22, y: 0.2 } },
        { id: 'b', x: 0.24, y: 0.2, hole: { x: 0.22, y: 0.2 } },
        { id: 'c', x: 0.8, y: 0.8 },
      ],
    };
    delete sides.ledGroups;
    render(<Editor initial={sides} />);
    fireEvent.click(screen.getByText('sprayLedSetup.pairLeds'));
    act(() => controls.canvas?.onTap?.({ x: 0.2, y: 0.2 }, 1000, 1000));
    expect(controls.layout?.ledGroups).toEqual([]);
    fireEvent.click(screen.getByText('undo'));
    expect(controls.layout?.ledGroups).toBeUndefined();
    expect(ledPairs(controls.layout!)).toEqual([['a', 'b']]);
  });

  it('Undo of the first hand-made pair leaves a layout with no list', () => {
    const { ledGroups: _none, ...single } = paired;
    render(<Editor initial={single} />);
    fireEvent.click(screen.getByText('sprayLedSetup.pairLeds'));
    act(() => controls.canvas?.onTap?.({ x: 0.2, y: 0.2 }, 1000, 1000));
    act(() => controls.canvas?.onTap?.({ x: 0.8, y: 0.8 }, 1000, 1000));
    expect(controls.layout?.ledGroups).toEqual([['a', 'c']]);
    fireEvent.click(screen.getByText('undo'));
    expect(controls.layout?.ledGroups).toBeUndefined();
    expect(ledPairs(controls.layout!)).toEqual([]);
  });

  it('drops removed pairs from the list, so the layout still saves', () => {
    const three: TnutLayout = {
      ...paired,
      ledPositions: [
        { id: 'a', x: 0.1, y: 0.1 },
        { id: 'b', x: 0.14, y: 0.1 },
        { id: 'c', x: 0.5, y: 0.5 },
        { id: 'd', x: 0.54, y: 0.5 },
        { id: 'e', x: 0.9, y: 0.9 },
        { id: 'f', x: 0.94, y: 0.9 },
      ],
      ledGroups: [
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ],
    };
    render(<Editor initial={three} />);
    fireEvent.click(screen.getByText('remove'));
    act(() => controls.canvas?.onTap?.({ x: 0.1, y: 0.1 }, 1000, 1000));
    act(() => controls.canvas?.onTap?.({ x: 0.5, y: 0.5 }, 1000, 1000));
    expect(controls.layout?.ledPositions?.map((led) => led.id)).toEqual(['e', 'f']);
    expect(controls.layout?.ledGroups).toEqual([['e', 'f']]);
    const saved = readTnutLayout(JSON.parse(JSON.stringify(controls.layout)));
    expect(saved?.ledGroups).toEqual([['e', 'f']]);
  });
});

describe('Skipped LEDs on a connection', () => {
  // Skips are undirected: this one names the connection's ends the other way round.
  const reversed: TnutLayout = {
    ...original,
    wiring: { direction: 'custom', startCorner: 'tl', paths: [['a', 'b']], skips: [{ from: 'b', to: 'a', count: 3 }] },
  };

  it('reads a skip stored in the other direction, and 0 clears it', () => {
    render(<Editor initial={reversed} kind="skips" />);
    act(() => controls.canvas?.onTap?.({ x: 0.5, y: 0.5 }, 400, 400));
    expect(screen.getByText('sprayLedSetup.gapLabel')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayLedSetup.insertSkips'));
    expect((screen.getByLabelText('skip count') as HTMLInputElement).value).toBe('3');
    fireEvent.change(screen.getByLabelText('skip count'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('sprayLed.confirm'));
    expect(controls.layout?.wiring?.skips).toEqual([]);
    expect(screen.getByText('sprayLedSetup.skipsNone')).toBeTruthy();
  });
});
