// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';

const controls = vi.hoisted(() => ({
  canvas: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null,
  alert: vi.fn(),
  changed: vi.fn(),
}));
vi.mock('react-native', () => ({
  Alert: { alert: controls.alert },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ brandColors: {} }) }));
vi.mock('../../../lib/spray/use-spray-led-preview', () => ({ useSprayLedPreview: vi.fn() }));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({ canvas }: { canvas: typeof controls.canvas }) => {
    controls.canvas = canvas;
    return null;
  },
}));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null, SPRAY_CABLE_COLOR: '' }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../../board-discovery/BoardMetaFields', () => ({ BuilderTextInput: () => null }));
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
function Editor({ initial = original }: { initial?: TnutLayout }) {
  const [layout, setLayout] = useState(initial);
  return (
    <SprayLedMapEditor
      kind="positions"
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
