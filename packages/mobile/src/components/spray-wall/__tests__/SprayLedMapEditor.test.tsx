// @vitest-environment jsdom
import { createElement, useState, type ReactElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addLedStripe,
  createLedStripes,
  DEFAULT_TNUT_CORNERS,
  ledPairs,
  readTnutLayout,
  type TnutLayout,
  type TnutWiring,
} from '@boardsesh/spray-wall-geometry';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';

const controls = vi.hoisted(() => ({
  canvas: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null,
  confirm: vi.fn(),
  changed: vi.fn(),
  layout: null as TnutLayout | null,
  preview: {
    available: false,
    state: 'lit',
    show: vi.fn(),
    showPair: vi.fn(),
    showUnit: vi.fn(),
    stop: vi.fn(),
    error: null,
  },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Modal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => controls.confirm }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: {}, systemColors: {}, spacing: [0, 4, 8, 12, 16] }),
}));
vi.mock('../../../lib/spray/use-spray-led-preview', () => ({
  useSprayLedPreview: () => controls.preview,
}));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({ canvas, overlayTools }: { canvas: typeof controls.canvas; overlayTools?: ReactNode }) => {
    controls.canvas = canvas;
    return createElement('div', null, overlayTools);
  },
}));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null, SPRAY_CABLE_COLOR: '' }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
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
  SprayPhotoToolButton: () => null,
  SprayUndoButton: ({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, 'overlay undo'),
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
function Editor({
  initial = original,
  kind = 'positions',
}: {
  initial?: TnutLayout;
  kind?: 'positions' | 'wiring' | 'skips';
}) {
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

function cableOverlay() {
  return controls.canvas?.renderOverlay?.(
    400,
    400,
    { value: 1 } as never,
    { value: 0 } as never,
    { value: 0 } as never,
    { value: null } as never,
  ) as ReactElement<{ wiring?: TnutWiring; showSkips?: boolean; distinguishSkips?: boolean }>;
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  controls.canvas = null;
  controls.preview.available = false;
  controls.preview.state = 'lit';
  controls.preview.show.mockReset().mockResolvedValue(true);
  controls.preview.showPair.mockReset().mockResolvedValue('pair');
  controls.preview.showUnit.mockReset().mockResolvedValue('unit');
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

  it('prunes both T-nut LED roles and upper hold links before an ID is reused, with undo', () => {
    const hole = { x: 0.5, y: 0.5 };
    const linked: TnutLayout = {
      ...original,
      holes: [hole],
      wiring: undefined,
      ledPositions: [{ id: 'manual-0', x: 0.2, y: 0.2 }],
      tnutLeds: [{ hole, ledIds: ['manual-0'], aboveLedIds: ['manual-0'] }],
      holdAboveLeds: [{ holdId: 10, ledIds: ['manual-0'] }],
    };
    render(<Editor initial={linked} />);
    fireEvent.click(screen.getByText('remove'));
    act(() => controls.canvas?.onTap?.({ x: 0.2, y: 0.2 }, 400, 400));
    expect(controls.layout?.tnutLeds).toEqual([{ hole, ledIds: [], aboveLedIds: [] }]);
    expect(controls.layout?.holdAboveLeds).toEqual([{ holdId: 10, ledIds: [] }]);
    fireEvent.click(screen.getByText('add'));
    act(() => controls.canvas?.onTap?.({ x: 0.8, y: 0.8 }, 400, 400));
    expect(controls.layout?.ledPositions?.[0].id).toBe('manual-0');
    expect(controls.layout?.tnutLeds).toEqual([{ hole, ledIds: [], aboveLedIds: [] }]);
    expect(controls.layout?.holdAboveLeds).toEqual([{ holdId: 10, ledIds: [] }]);
    fireEvent.click(screen.getByText('undo'));
    fireEvent.click(screen.getByText('undo'));
    expect(controls.layout).toEqual(linked);
  });

  it.each(['add', 'remove'] as const)(
    'requires confirmation before %s discards a cable and undo restores it',
    async (mode) => {
      let accept: (answer: boolean) => void = () => undefined;
      controls.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (accept = resolve)));
      render(<Editor />);
      fireEvent.click(screen.getByText(mode));
      act(() => controls.canvas?.onTap?.(mode === 'add' ? { x: 0.5, y: 0.5 } : { x: 0.2, y: 0.2 }, 400, 400));
      expect(controls.changed).not.toHaveBeenCalled();
      expect(controls.confirm).toHaveBeenCalledWith({
        title: 'sprayLedSetup.clearCableTitle',
        message: 'sprayLedSetup.clearCableBody',
        cancelLabel: 'sprayLedSetup.keepEditing',
        confirmLabel: 'sprayLedSetup.clearCable',
        destructive: true,
      });
      await act(async () => accept(true));
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
    expect(controls.confirm).not.toHaveBeenCalled();
    expect(controls.changed.mock.lastCall?.[0]).not.toHaveProperty('wiring');
  });
  it('adds immediately when no cable has been laid', () => {
    render(<Editor initial={{ ...original, wiring: { ...original.wiring!, paths: [], skips: [] } }} />);
    fireEvent.click(screen.getByText('add'));
    act(() => controls.canvas?.onTap?.({ x: 0.5, y: 0.5 }, 400, 400));
    expect(controls.confirm).not.toHaveBeenCalled();
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

  it.each([
    { partnerX: 0.3, otherX: 0.4, destinationX: 0.3, nearest: 'partner' },
    { partnerX: 0.6, otherX: 0.62, destinationX: 0.21, nearest: 'dragged LED' },
    { partnerX: 0.3, otherX: 0.5, destinationX: 0.4, nearest: 'no LED' },
  ])('rejects a partner collision when the dragged target is nearest $nearest', (scenario) => {
    const initial: TnutLayout = {
      ...paired,
      ledPositions: [
        { id: 'a', x: 0.2, y: 0.5 },
        { id: 'b', x: scenario.partnerX, y: 0.5 },
        { id: 'c', x: scenario.otherX, y: 0.5 },
      ],
    };
    render(<Editor initial={initial} />);
    fireEvent.click(screen.getByText('move'));
    act(() => controls.canvas?.onMove?.({ x: 0.2, y: 0.5 }, { x: scenario.destinationX, y: 0.5 }, 400, 400));
    expect(controls.changed).not.toHaveBeenCalled();
    expect(controls.layout).toBe(initial);
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

describe('continuing cut cable sections', () => {
  const sectioned: TnutLayout = {
    ...original,
    ledPositions: [
      { id: 'a', x: 0.1, y: 0.1 },
      { id: 'b', x: 0.3, y: 0.1 },
      { id: 'c', x: 0.7, y: 0.1 },
      { id: 'd', x: 0.9, y: 0.1 },
      { id: 'e', x: 0.3, y: 0.6 },
      { id: 'f', x: 0.3, y: 0.9 },
      { id: 'g', x: 0.9, y: 0.6 },
    ],
    wiring: {
      ...original.wiring!,
      paths: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      skips: [{ from: 'a', to: 'b', count: 2 }],
    },
  };
  const tap = (x: number, y: number) => act(() => controls.canvas?.onTap?.({ x, y }, 400, 400));

  it('selects either output end without adding a history step and extends it in place', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.1);
    expect(controls.changed).not.toHaveBeenCalled();
    expect((screen.getByText('overlay undo') as HTMLButtonElement).disabled).toBe(true);
    tap(0.3, 0.6);
    tap(0.3, 0.9);
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e', 'f'],
      ['c', 'd'],
    ]);
    expect(controls.layout?.wiring?.skips).toEqual(sectioned.wiring?.skips);
    tap(0.9, 0.1);
    tap(0.9, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e', 'f'],
      ['c', 'd', 'g'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e', 'f'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual(sectioned.wiring?.paths);
    expect((screen.getByText('overlay undo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('joins a chosen output to a later section input and continues from its existing tail', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.1);
    tap(0.7, 0.1);
    tap(0.3, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'c', 'd', 'e']]);
  });

  it('joins an encountered section input without retargeting to its later output', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    const stroke = [
      { x: 0.3, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.6 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    const preview = cableOverlay().props.wiring;
    expect(preview?.paths).toEqual([['a', 'b', 'c', 'd', 'g']]);
    expect(controls.layout?.wiring?.paths).toEqual(sectioned.wiring?.paths);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring).toEqual(preview);
  });

  it('reconnects an actual interior cut by tapping its input and undoes join and cut separately', () => {
    const initial = {
      ...sectioned,
      wiring: {
        ...sectioned.wiring!,
        paths: [['a', 'b', 'c', 'd']],
        skips: [
          { from: 'a', to: 'b', count: 2 },
          { from: 'b', to: 'c', count: 3 },
          { from: 'c', to: 'd', count: 1 },
        ],
      },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectLeds'));
    tap(0.3, 0.1);
    tap(0.7, 0.1);
    fireEvent.click(screen.getByText('sprayLedSetup.cutCable'));
    const split = controls.layout?.wiring;
    expect(split?.paths).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.1);
    tap(0.7, 0.1);
    expect(controls.layout?.wiring?.paths).toEqual(initial.wiring.paths);
    expect(controls.layout?.wiring?.skips).toEqual([
      { from: 'a', to: 'b', count: 2 },
      { from: 'c', to: 'd', count: 1 },
    ]);
    expect(controls.layout?.wiring?.initialSkip).toBe(initial.wiring.initialSkip);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(split);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(initial.wiring);
  });

  it('joins after extending the chosen output and preserves one Undo step per action', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.1);
    tap(0.3, 0.6);
    const extended = controls.layout?.wiring;
    expect(extended?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'd'],
    ]);
    tap(0.7, 0.1);
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'e', 'c', 'd']]);
    expect(controls.layout?.wiring?.skips).toEqual(sectioned.wiring?.skips);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(extended);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
  });

  it('previews and commits a direct drag join as one reversible edit', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    const stroke = [
      { x: 0.3, y: 0.1 },
      { x: 0.7, y: 0.1 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    const preview = cableOverlay().props.wiring;
    expect(preview?.paths).toEqual([['a', 'b', 'c', 'd']]);
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring).toEqual(preview);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
  });

  it('previews an extension followed by a join and undoes both stops independently', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    const stroke = [
      { x: 0.3, y: 0.1 },
      { x: 0.3, y: 0.6 },
      { x: 0.7, y: 0.1 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    const preview = cableOverlay().props.wiring;
    expect(preview?.paths).toEqual([['a', 'b', 'e', 'c', 'd']]);
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring).toEqual(preview);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
  });

  it('continues after a join in the same drag and keeps all three edits independently reversible', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    const stroke = [
      { x: 0.3, y: 0.1 },
      { x: 0.3, y: 0.6 },
      { x: 0.7, y: 0.1 },
      { x: 0.3, y: 0.9 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    const preview = cableOverlay().props.wiring;
    expect(preview?.paths).toEqual([['a', 'b', 'e', 'c', 'd', 'f']]);
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring).toEqual(preview);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'e', 'c', 'd']]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(sectioned.wiring);
  });

  it('starts a fresh drag from a whole target pair output instead of joining the previous source', () => {
    const initial = {
      ...sectioned,
      ledGroups: [
        ['a', 'b'],
        ['c', 'd'],
      ] as [string, string][],
      wiring: {
        ...sectioned.wiring!,
        paths: [
          ['a', 'b'],
          ['d', 'c'],
        ],
      },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 0.1);
    const stroke = [
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.6 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    const preview = cableOverlay().props.wiring;
    expect(preview?.paths).toEqual([
      ['a', 'b'],
      ['d', 'c', 'g'],
    ]);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring).toEqual(preview);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
  });

  it('joins a later singleton input by Tap rather than only selecting its output', () => {
    const initial = { ...sectioned, wiring: { ...sectioned.wiring!, paths: [['a', 'b'], ['c']] } };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.1);
    tap(0.7, 0.1);
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'c']]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(initial.wiring);
  });

  it('rejoins a singleton controller root without moving that root behind another section', () => {
    const initial = { ...sectioned, wiring: { ...sectioned.wiring!, paths: [['a'], ['b', 'c', 'd']], skips: [] } };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 0.1);
    tap(0.3, 0.1);
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'c', 'd']]);
    expect(controls.layout?.wiring?.initialSkip).toBe(initial.wiring.initialSkip);
  });

  it('never joins an output to its own input or another section interior', () => {
    const initial = {
      ...sectioned,
      ledPositions: [...sectioned.ledPositions!, { id: 'inside', x: 0.8, y: 0.1 }],
      wiring: {
        ...sectioned.wiring!,
        paths: [
          ['a', 'b'],
          ['c', 'inside', 'd'],
        ],
      },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.1);
    tap(0.1, 0.1);
    tap(0.8, 0.1);
    expect(controls.changed).not.toHaveBeenCalled();
    tap(0.3, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'inside', 'd'],
    ]);
  });

  it('rejects backward joins to both the controller root and an earlier non-root section', () => {
    const initial = {
      ...sectioned,
      wiring: {
        ...sectioned.wiring!,
        paths: [
          ['a', 'b'],
          ['c', 'd'],
          ['e', 'f'],
        ],
      },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.9);
    tap(0.1, 0.1);
    tap(0.7, 0.1);
    expect(controls.changed).not.toHaveBeenCalled();
    tap(0.9, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f', 'g'],
    ]);
  });

  it.each([0.7, 0.9])('joins a reversed input pair through either member at x=%s', (x) => {
    const initial = {
      ...sectioned,
      ledGroups: [
        ['a', 'b'],
        ['c', 'd'],
      ] as [string, string][],
      wiring: {
        ...sectioned.wiring!,
        paths: [
          ['a', 'b'],
          ['d', 'c'],
        ],
      },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 0.1);
    tap(x, 0.1);
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'd', 'c']]);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(initial.wiring);
  });

  it.each([0, 0.5, 1])('joins a whole reversed input stripe through its member at y=%s', (y) => {
    const stripes = createLedStripes(
      {
        ...original,
        ledPlacement: 'stripe',
        columns: 2,
        rows: 2,
        holes: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.9 },
        ],
      },
      'vertical',
      3,
    );
    if (stripes === 'capacity') throw new Error('Unexpected fixture capacity');
    const [first, target] = stripes.ledStripes!.stripes.map((stripe) => stripe.ledIds);
    const second = [...target].reverse();
    const initial = { ...stripes, wiring: { ...original.wiring!, paths: [first, second], skips: [] } };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 0.5);
    tap(0.9, y);
    expect(controls.layout?.wiring?.paths).toEqual([[...first, ...second]]);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring).toEqual(initial.wiring);
  });

  it('keeps the intermediate output across a multi-stop drag and undoes each addition', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    const stroke = [
      { x: 0.3, y: 0.1 },
      { x: 0.3, y: 0.6 },
      { x: 0.3, y: 0.9 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    expect(cableOverlay().props.wiring?.paths).toEqual([
      ['a', 'b', 'e', 'f'],
      ['c', 'd'],
    ]);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e', 'f'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'd'],
    ]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual(sectioned.wiring?.paths);
  });

  it('does not choose an output crossed later when the drag begins at a section input', () => {
    render(<Editor initial={sectioned} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    const stroke = [
      { x: 0.7, y: 0.1 },
      { x: 0.3, y: 0.1 },
      { x: 0.3, y: 0.6 },
    ];
    act(() => controls.canvas?.onTraceProgress?.(stroke, 0.01));
    expect(cableOverlay().props.wiring?.paths).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e'],
    ]);
    act(() => controls.canvas?.onTrace?.(stroke, 0.01));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e'],
    ]);
  });

  it('returns a cut terminal LED to ordinary Lay cable and restores the cut with Undo', () => {
    const initial = {
      ...sectioned,
      wiring: { ...sectioned.wiring!, paths: [['a', 'b', 'e']], skips: [] },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectLeds'));
    tap(0.3, 0.1);
    tap(0.3, 0.6);
    fireEvent.click(screen.getByText('sprayLedSetup.cutCable'));
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b']]);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.3, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual(initial.wiring.paths);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b']]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual(initial.wiring.paths);
  });

  it.each([0.1, 0.3])('resolves either tail-pair member at x=%s to its output', (x) => {
    render(
      <Editor
        initial={{
          ...sectioned,
          ledGroups: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        }}
        kind="wiring"
      />,
    );
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(x, 0.1);
    tap(0.3, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual([
      ['a', 'b', 'e'],
      ['c', 'd'],
    ]);
  });

  it('does not select a partial legacy pair as another section output', () => {
    render(
      <Editor
        initial={{
          ...sectioned,
          ledGroups: [['a', 'b']],
          wiring: { ...sectioned.wiring!, paths: [['a'], ['b', 'c', 'd']], skips: [] },
        }}
        kind="wiring"
      />,
    );
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 0.1);
    tap(0.3, 0.6);
    expect(controls.layout?.wiring?.paths).toEqual([['a'], ['b', 'c', 'd', 'e']]);
  });

  it('selects a whole terminal strip from its middle without branching inside it', () => {
    const stripes = createLedStripes(
      {
        ...original,
        ledPlacement: 'stripe',
        columns: 2,
        rows: 2,
        holes: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.9 },
        ],
      },
      'vertical',
      3,
    );
    if (stripes === 'capacity') throw new Error('Unexpected fixture capacity');
    const [first, second] = stripes.ledStripes!.stripes.map((stripe) => stripe.ledIds);
    const withLoose = addLedStripe(stripes, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }, 1);
    if (withLoose === 'capacity') throw new Error('Unexpected fixture capacity');
    const looseId = withLoose.ledStripes!.stripes[2].ledIds[0];
    const initial = {
      ...withLoose,
      wiring: { ...original.wiring!, paths: [first, second], skips: [] },
    };
    render(<Editor initial={initial} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 0.5);
    tap(0.5, 0.5);
    expect(controls.layout?.wiring?.paths).toEqual([[...first, looseId], second]);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
  });
});

describe('paired cable actions', () => {
  const grouped: TnutLayout = {
    ...original,
    ledPositions: [
      { id: 'a', x: 0.2, y: 0.2 },
      { id: 'b', x: 0.4, y: 0.2 },
      { id: 'c', x: 0.2, y: 0.7 },
      { id: 'd', x: 0.4, y: 0.7 },
      { id: 'e', x: 0.8, y: 0.8 },
    ],
    ledGroups: [
      ['a', 'b'],
      ['c', 'd'],
    ],
    wiring: {
      ...original.wiring!,
      paths: [['b', 'a', 'd', 'c', 'e']],
      skips: [{ from: 'a', to: 'd', count: 2 }],
    },
  };
  const tap = (x: number, y: number) => act(() => controls.canvas?.onTap?.({ x, y }, 400, 400));
  const selected = () => {
    const overlay = controls.canvas?.renderOverlay?.(
      400,
      400,
      { value: 1 } as never,
      { value: 0 } as never,
      { value: 0 } as never,
      { value: null } as never,
    ) as ReactElement<{ selected: string[] }>;
    return overlay.props.selected;
  };

  it('selects two pairs and cuts only the real boundary between their units', () => {
    render(<Editor initial={grouped} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectLeds'));
    tap(0.4, 0.2);
    expect(selected()).toEqual(['a', 'b']);
    tap(0.2, 0.2);
    expect(selected()).toEqual([]);
    tap(0.4, 0.2);
    tap(0.2, 0.7);
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
    fireEvent.click(screen.getByText('sprayLedSetup.cutCable'));
    expect(controls.layout?.wiring?.paths).toEqual([
      ['b', 'a'],
      ['d', 'c', 'e'],
    ]);
    fireEvent.click(screen.getByText('sprayLedSetup.connectCable'));
    expect(controls.layout?.wiring?.paths).toEqual(grouped.wiring?.paths);
  });

  it('undoes a tapped pair together and keeps its cable connections editable', () => {
    render(
      <Editor initial={{ ...grouped, wiring: { ...grouped.wiring!, paths: [['e']], skips: [] } }} kind="wiring" />,
    );
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.2, 0.2);
    expect(controls.layout?.wiring?.paths).toEqual([['e', 'a', 'b']]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([['e']]);

    fireEvent.click(screen.getByText('sprayLedSetup.selectLeds'));
    tap(0.8, 0.8);
    tap(0.2, 0.2);
    const connect = screen.getByText('sprayLedSetup.connectCable') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(controls.layout?.wiring?.paths).toEqual([['e', 'a', 'b']]);
    const cut = screen.getByText('sprayLedSetup.cutCable') as HTMLButtonElement;
    expect(cut.disabled).toBe(false);
    fireEvent.click(cut);
    expect(controls.layout?.wiring?.paths).toEqual([['e']]);
  });

  it('undoes each pair stop separately after a cable drag crosses both pairs', () => {
    render(<Editor initial={{ ...grouped, wiring: { ...grouped.wiring!, paths: [], skips: [] } }} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    act(() =>
      controls.canvas?.onTrace?.(
        [
          { x: 0.2, y: 0.2 },
          { x: 0.2, y: 0.7 },
        ],
        0.01,
      ),
    );
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b', 'c', 'd']]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b']]);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([]);
  });

  it('wires a pair atomically, skips before it, advances twice and undoes both LEDs', async () => {
    controls.preview.available = true;
    render(<Editor initial={{ ...grouped, wiring: { ...original.wiring!, paths: [], skips: [] } }} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await act(async () => {});
    tap(0.4, 0.2);
    await waitFor(() => expect(controls.layout?.wiring?.paths).toEqual([['b', 'a']]));
    expect(controls.preview.showPair).toHaveBeenCalledExactlyOnceWith(4);
    expect(controls.layout?.wiring?.initialSkip).toBe(4);
    expect(controls.preview.show).toHaveBeenLastCalledWith([6]);
    expect(controls.changed).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([]);
    expect(controls.layout?.wiring?.initialSkip).toBe(4);
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.initialSkip).toBe(3);
  });

  it('discards a delayed pair acknowledgement after changing the cable tool', async () => {
    controls.preview.available = true;
    let acknowledge!: (result: string) => void;
    controls.preview.showPair.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          acknowledge = resolve;
        }),
    );
    render(<Editor initial={{ ...grouped, wiring: { ...original.wiring!, paths: [], skips: [] } }} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await act(async () => {});
    tap(0.2, 0.2);
    expect(controls.preview.showPair).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByText('sprayLedSetup.selectLeds'));
    await act(async () => acknowledge('pair'));
    expect(controls.changed).not.toHaveBeenCalled();
  });

  it('discards a delayed pair acknowledgement after Undo removes its preceding skip', async () => {
    controls.preview.available = true;
    let acknowledge!: (result: string) => void;
    controls.preview.showPair.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          acknowledge = resolve;
        }),
    );
    render(
      <Editor initial={{ ...grouped, wiring: { ...original.wiring!, paths: [['e']], skips: [] } }} kind="wiring" />,
    );
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([4]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([5]));
    tap(0.2, 0.2);
    expect(controls.preview.showPair).toHaveBeenCalledWith(5);
    const undo = screen.getByText('overlay undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([4]));
    await act(async () => acknowledge('pair'));
    expect(controls.layout?.wiring?.paths).toEqual([['e']]);
    expect(controls.layout?.wiring?.skips).toEqual([]);
  });

  it('keeps the cable after a rejected pair and accepts a valid single assignment', async () => {
    controls.preview.available = true;
    controls.preview.showPair.mockResolvedValueOnce('single');
    render(<Editor initial={{ ...grouped, wiring: { ...original.wiring!, paths: [], skips: [] } }} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await act(async () => {});
    tap(0.2, 0.2);
    await screen.findByText('sprayLedSetup.lightAndTapPairFailed');
    expect(controls.changed).not.toHaveBeenCalled();
    tap(0.8, 0.8);
    expect(controls.layout?.wiring?.paths).toEqual([['e']]);
  });
});

describe('Light and tap skip history', () => {
  const tap = (x: number, y: number) => act(() => controls.canvas?.onTap?.({ x, y }, 400, 400));

  it('updates leading skips immediately and undoes each one before the first LED is assigned', async () => {
    controls.preview.available = true;
    render(<Editor initial={{ ...original, wiring: { ...original.wiring!, paths: [], skips: [] } }} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([4]));
    expect(controls.layout?.wiring?.initialSkip).toBe(4);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([5]));
    expect(controls.layout?.wiring?.initialSkip).toBe(5);
    expect(cableOverlay().props.wiring?.paths).toEqual([]);
    expect(cableOverlay().props.wiring?.skips).toEqual([]);

    const undo = screen.getByText('overlay undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([4]));
    expect(controls.layout?.wiring?.initialSkip).toBe(4);
    fireEvent.click(undo);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    expect(controls.layout?.wiring?.initialSkip).toBe(3);
    expect(undo.disabled).toBe(true);
  });

  it('marks skipped cable slots and undoes the assignment and skip taps in reverse order', async () => {
    controls.preview.available = true;
    render(
      <Editor
        initial={{
          ...original,
          ledPositions: [...original.ledPositions!, { id: 'c', x: 0.5, y: 0.8 }],
          wiring: { ...original.wiring!, initialSkip: 0, paths: [], skips: [] },
        }}
        kind="wiring"
      />,
    );
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([0]));
    tap(0.2, 0.2);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([1]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([2]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    tap(0.8, 0.8);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([4]));
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b']]);
    expect(cableOverlay().props.wiring?.skips).toEqual([{ from: 'a', to: 'b', count: 2 }]);
    expect(cableOverlay().props.showSkips).not.toBe(false);
    expect(cableOverlay().props.distinguishSkips).toBe(true);

    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([['a']]);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    fireEvent.click(screen.getByText('overlay undo'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([2]));
    fireEvent.click(screen.getByText('overlay undo'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([1]));
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([]);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([0]));
    expect((screen.getByText('overlay undo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps skipped slots marked after the last Light and tap assignment, but hides them in Lay cable', async () => {
    controls.preview.available = true;
    render(
      <Editor
        initial={{ ...original, wiring: { ...original.wiring!, initialSkip: 0, paths: [], skips: [] } }}
        kind="wiring"
      />,
    );
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([0]));
    tap(0.2, 0.2);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([1]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([2]));
    tap(0.8, 0.8);
    await waitFor(() => expect(controls.preview.stop).toHaveBeenCalled());
    expect(controls.layout?.wiring?.paths).toEqual([['a', 'b']]);
    expect(cableOverlay().props.showSkips).not.toBe(false);
    expect(cableOverlay().props.distinguishSkips).toBe(true);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    expect(cableOverlay().props.showSkips).toBe(false);
    expect(controls.layout?.wiring?.skips).toEqual([{ from: 'a', to: 'b', count: 1 }]);
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

  it('hits the midpoint connection, rings and lights both pairs, and updates the physical gap', () => {
    controls.preview.available = true;
    render(
      <Editor
        kind="skips"
        initial={{
          ...original,
          ledPositions: [
            { id: 'a', x: 0.1, y: 0.2 },
            { id: 'b', x: 0.7, y: 0.2 },
            { id: 'c', x: 0.2, y: 0.8 },
            { id: 'd', x: 0.8, y: 0.8 },
          ],
          ledGroups: [
            ['a', 'b'],
            ['c', 'd'],
          ],
          wiring: { ...original.wiring!, paths: [['a', 'b', 'c', 'd']], skips: [{ from: 'b', to: 'c', count: 2 }] },
        }}
      />,
    );
    // Near the rendered midpoint line only, away from the diagonal between b and c.
    act(() => controls.canvas?.onTap?.({ x: 0.4167, y: 0.3 }, 400, 400));
    const overlay = controls.canvas?.renderOverlay?.(
      400,
      400,
      { value: 1 } as never,
      { value: 0 } as never,
      { value: 0 } as never,
      { value: null } as never,
    ) as ReactElement<{ selected: string[] }>;
    expect(overlay.props.selected.toSorted()).toEqual(['a', 'b', 'c', 'd']);
    expect(controls.preview.show).toHaveBeenLastCalledWith([3, 4, 7, 8]);

    fireEvent.click(screen.getByText('sprayLedSetup.insertSkips'));
    fireEvent.change(screen.getByLabelText('skip count'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('sprayLed.confirm'));
    expect(controls.layout?.wiring?.skips).toEqual([{ from: 'b', to: 'c', count: 3 }]);
    expect(controls.preview.show).toHaveBeenLastCalledWith([3, 4, 8, 9]);
    fireEvent.click(screen.getByText('sprayLedSetup.skipsEndsOff'));
    expect(controls.preview.stop).toHaveBeenCalledTimes(1);
  });
});

describe('indivisible stripe cable actions', () => {
  function striped(wired = false): TnutLayout {
    const created = createLedStripes(
      {
        ...original,
        holes: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.9 },
        ],
      },
      'vertical',
      3,
    );
    if (created === 'capacity') throw new Error('Unexpected fixture capacity');
    const ids = created.ledStripes!.stripes.flatMap((stripe) => stripe.ledIds);
    return {
      ...created,
      wiring: { direction: 'custom', startCorner: 'tl', initialSkip: 3, paths: wired ? [ids] : [], skips: [] },
    };
  }
  const tap = (x: number, y: number) => act(() => controls.canvas?.onTap?.({ x, y }, 400, 400));
  function selectedIds() {
    const overlay = controls.canvas?.renderOverlay?.(
      400,
      400,
      { value: 1 } as never,
      { value: 0 } as never,
      { value: 0 } as never,
      { value: null } as never,
    ) as ReactElement<{ selected: string[] }> | undefined;
    if (!overlay) throw new Error('Cable overlay was not rendered');
    return overlay.props.selected;
  }

  it('lays the complete stripe from either end and undoes it in one action', () => {
    const layout = striped();
    const unit = layout.ledStripes!.stripes[0].ledIds;
    render(<Editor initial={layout} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.drawCable'));
    tap(0.1, 1);
    expect(controls.layout?.wiring?.paths).toEqual([[...unit].reverse()]);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([]);
  });

  it('treats two stripes as two selections and cuts only their shared boundary', () => {
    const layout = striped(true);
    const [first, second] = layout.ledStripes!.stripes.map((stripe) => stripe.ledIds);
    render(<Editor initial={layout} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.selectLeds'));
    tap(0.1, 0.5);
    expect(selectedIds()).toEqual(first);
    tap(0.1, 0);
    expect(selectedIds()).toEqual([]);
    tap(0.1, 0.5);
    tap(0.9, 0.5);
    expect(selectedIds()).toEqual([...first, ...second]);
    fireEvent.click(screen.getByText('sprayLedSetup.cutCable'));
    expect(controls.layout?.wiring?.paths).toEqual([first]);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
    fireEvent.click(screen.getByText('sprayLedSetup.connectCable'));
    expect(controls.layout?.wiring?.paths).toEqual(layout.wiring?.paths);
  });

  it('confirms and advances every physical stripe index together in Light and tap', async () => {
    controls.preview.available = true;
    const layout = striped();
    const unit = layout.ledStripes!.stripes[0].ledIds;
    render(<Editor initial={layout} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    tap(0.1, 0.5);
    await waitFor(() => expect(controls.layout?.wiring?.paths).toEqual([unit]));
    expect(controls.preview.showUnit).toHaveBeenCalledWith(3, 3);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([6]));
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([]);
  });

  it('undoes a completed stripe as one unit before undoing the skipped slot ahead of it', async () => {
    controls.preview.available = true;
    const layout = striped();
    const [first, second] = layout.ledStripes!.stripes.map((stripe) => stripe.ledIds);
    render(<Editor initial={layout} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    tap(0.1, 0.5);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([6]));
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTapSkip'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([7]));
    tap(0.9, 0.5);
    await waitFor(() => expect(controls.layout?.wiring?.paths).toEqual([[...first, ...second]]));
    expect(controls.preview.showUnit).toHaveBeenLastCalledWith(7, 3);
    expect(cableOverlay().props.wiring?.skips).toEqual([{ from: first[2], to: second[0], count: 1 }]);
    expect(cableOverlay().props.distinguishSkips).toBe(true);

    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([first]);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([7]));
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([first]);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([6]));
    fireEvent.click(screen.getByText('overlay undo'));
    expect(controls.layout?.wiring?.paths).toEqual([]);
    expect(readTnutLayout(controls.layout)).not.toBeNull();
  });

  it('never saves a partial stripe when its last physical LED exceeds the controller', async () => {
    controls.preview.available = true;
    controls.preview.showUnit.mockResolvedValueOnce('single');
    render(<Editor initial={striped()} kind="wiring" />);
    fireEvent.click(screen.getByText('sprayLedSetup.lightAndTap'));
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3]));
    tap(0.1, 0.5);
    await waitFor(() => expect(screen.queryByText('sprayLedSetup.lightAndTapUnitFailed')).not.toBeNull());
    expect(controls.layout?.wiring?.paths).toEqual([]);
  });

  it('edits skipped LEDs only between whole stripes and previews both complete units', async () => {
    controls.preview.available = true;
    const layout = striped(true);
    render(<Editor initial={layout} kind="skips" />);
    tap(0.1, 0.25);
    expect(controls.preview.show).not.toHaveBeenCalled();
    tap(0.5, 0.5);
    await waitFor(() => expect(controls.preview.show).toHaveBeenLastCalledWith([3, 4, 5, 6, 7, 8]));
    expect(selectedIds()).toEqual(layout.ledStripes!.stripes.flatMap((stripe) => stripe.ledIds));
    fireEvent.click(screen.getByText('sprayLedSetup.insertSkips'));
    fireEvent.change(screen.getByLabelText('skip count'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('sprayLed.confirm'));
    expect(readTnutLayout(controls.layout)).not.toBeNull();
    expect(controls.layout?.wiring?.skips).toEqual([
      {
        from: layout.ledStripes!.stripes[0].ledIds[2],
        to: layout.ledStripes!.stripes[1].ledIds[0],
        count: 2,
      },
    ]);
  });
});
