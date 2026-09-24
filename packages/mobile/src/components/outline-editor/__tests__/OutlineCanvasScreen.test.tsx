// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stroke: [80, 80, 120, 80, 120, 120, 80, 120, 80, 80],
  save: vi.fn(),
  alert: vi.fn(),
  holdShape: 'outline' as 'outline' | 'circle',
  rejectNextFinish: false,
  rendererAvailable: true as boolean | null,
  placementId: 42,
  geometryPending: false,
  prefetchGeometry: vi.fn(),
  overrides: [] as {
    placementId: number;
    kind: 'LED_INNER';
    outline: number[];
    updatedAt: string;
    authorDisplayName: null;
  }[],
}));
vi.mock('@boardsesh/board-art-geometry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@boardsesh/board-art-geometry')>();
  return {
    ...original,
    boardArtGeometryPending: () => state.geometryPending,
    loadBoardArtGeometry: (...args: Parameters<typeof original.loadBoardArtGeometry>) =>
      state.geometryPending ? null : original.loadBoardArtGeometry(...args),
    prefetchBoardArtGeometry: state.prefetchGeometry,
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return { useSharedValue: (value: unknown) => useRef({ value }).current };
});
const HOLD = { id: 42, cx: 100, cy: 100, r: 28 };
vi.mock('react-native', async () => {
  const { createElement, useEffect } = await import('react');
  const MockView = ({ children, onLayout }: { children?: React.ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 200 } } });
    }, [onLayout]);
    return createElement('div', null, children);
  };
  return {
    Platform: { OS: 'android' },
    View: MockView,
    ScrollView: MockView,
    Text: ({ children }: { children?: React.ReactNode }) => createElement('span', null, children),
    Pressable: ({ testID, onPress, disabled }: { testID: string; onPress?: () => void; disabled?: boolean }) =>
      createElement('button', { 'data-testid': testID, onClick: onPress, disabled }),
    ActivityIndicator: () => null,
    Alert: { alert: state.alert },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
  };
});
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', label: '#000' } }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useHoldOutlines: () => ({ data: { shardOutlines: [], overrides: state.overrides }, isLoading: false }),
  useUpsertHoldOutlineOverride: () => ({ mutate: state.save, isPending: false }),
  useDeleteHoldOutlineOverride: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({
  useEffectiveBoardRenderSettings: () => ({
    effectiveRenderSettings: { mode: 'aura', boardsesh: { holdShape: state.holdShape } },
    boardseshRendererAvailable: state.rendererAvailable,
  }),
}));
vi.mock('../../../lib/create-board-holds', () => ({
  getCreateBoardHolds: () => ({ boardWidth: 200, boardHeight: 200, holdTargets: [{ ...HOLD, id: state.placementId }] }),
  parseSetIdsParam: () => [1],
}));
vi.mock('../../Text', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('../../ActivityIndicator', async () => ({
  ActivityIndicator: (await import('react-native')).ActivityIndicator,
}));
vi.mock('../stroke', async (importOriginal) => {
  const original = await importOriginal<typeof import('../stroke')>();
  return {
    ...original,
    finishOutlineRing: (...args: Parameters<typeof original.finishOutlineRing>) => {
      if (state.rejectNextFinish) {
        state.rejectNextFinish = false;
        return { ok: false as const, reason: 'centre-outside' as const };
      }
      return original.finishOutlineRing(...args);
    },
  };
});
vi.mock('../OutlineSvgLayer', () => ({ OutlineSvgLayer: () => null }));
vi.mock('../../search/InteractiveFilterBoard', async () => {
  const { createElement } = await import('react');
  const { View: MockView } = await import('react-native');
  return {
    InteractiveFilterBoard: (props: { renderAboveBoard?: (context: unknown) => React.ReactNode }) =>
      createElement(MockView, null, props.renderAboveBoard?.({})),
  };
});
vi.mock('../DrawStrokeOverlay', async () => {
  const { createElement } = await import('react');
  const { Pressable, View: MockView } = await import('react-native');
  return {
    DrawStrokeOverlay: (props: {
      onStrokeStart: () => void;
      onStrokeEnd: (points: number[]) => void;
      onStrokeCancel: () => void;
    }) =>
      createElement(
        MockView,
        null,
        createElement(Pressable, {
          testID: 'stroke',
          onPress: () => {
            props.onStrokeStart();
            props.onStrokeEnd(state.stroke);
          },
        }),
        createElement(Pressable, { testID: 'stroke-start', onPress: props.onStrokeStart }),
        createElement(Pressable, { testID: 'stroke-end', onPress: () => props.onStrokeEnd(state.stroke) }),
        createElement(Pressable, { testID: 'stroke-cancel', onPress: props.onStrokeCancel }),
      ),
  };
});
vi.mock('../EditToolbar', async () => {
  const { createElement } = await import('react');
  const { Pressable, Text: MockText, View: MockView } = await import('react-native');
  return {
    EditToolbar: (props: {
      onNextPlacement: () => void;
      onEditKindChange: (kind: 'LED_INNER') => void;
      onDrawModeChange: (mode: 'add') => void;
      onSave: () => void;
      onUndo: () => void;
      onDiscardDraft: () => void;
      onDeselect: () => void;
      hasDraft: boolean;
      canUndo: boolean;
      canBrush: boolean;
      previewAvailable: boolean;
      previewUnavailableNote?: string;
    }) =>
      createElement(
        MockView,
        null,
        createElement(Pressable, { testID: 'next', onPress: props.onNextPlacement }),
        createElement(Pressable, { testID: 'inner', onPress: () => props.onEditKindChange('LED_INNER') }),
        createElement(Pressable, {
          testID: 'add',
          disabled: !props.canBrush,
          onPress: () => props.onDrawModeChange('add'),
        }),
        createElement(Pressable, { testID: 'save', onPress: props.onSave, disabled: !props.hasDraft }),
        createElement(Pressable, { testID: 'undo', onPress: props.onUndo, disabled: !props.canUndo }),
        createElement(Pressable, { testID: 'discard', onPress: props.onDiscardDraft }),
        createElement(Pressable, { testID: 'deselect', onPress: props.onDeselect }),
        createElement(Pressable, { testID: 'preview', disabled: !props.previewAvailable }),
        createElement(MockText, null, props.previewUnavailableNote),
      ),
  };
});

import { OutlineCanvasScreen } from '../OutlineCanvasScreen';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { brushEditOutline } from '@boardsesh/board-art-geometry/brush';
import { finishOutlineRing, radiusRingToBoardPx } from '../stroke';

beforeEach(() => {
  state.save.mockClear();
  state.alert.mockClear();
  state.holdShape = 'outline';
  state.rejectNextFinish = false;
  state.rendererAvailable = true;
  state.placementId = 42;
  state.geometryPending = false;
  state.prefetchGeometry.mockReset();
  state.overrides = [];
  state.stroke = [80, 80, 120, 80, 120, 120, 80, 120, 80, 80];
});

describe('outline redraw then brush', () => {
  it('brushes the first unsaved redraw on a hold with no stored outline', () => {
    const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={1} sizeId={28} setIds="1" />);
    fireEvent.click(screen.getByTestId('next'));
    expect((screen.getByTestId('add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('stroke'));
    expect((screen.getByTestId('add') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('add'));
    state.stroke = [120, 100, 127, 100];
    fireEvent.click(screen.getByTestId('stroke'));
    fireEvent.click(screen.getByTestId('save'));
    expect(state.save).toHaveBeenCalledOnce();
    const outline = state.save.mock.calls[0][0].outline as number[];
    const rightmost = Math.max(...outline.filter((_, index) => index % 2 === 0));
    expect(rightmost).toBeGreaterThan(20 / HOLD.r);
  });
});

it('does not carry a rejected final ring into the next brush stroke', () => {
  const draw = (rejectOneStroke: boolean) => {
    state.stroke = [80, 80, 120, 80, 120, 120, 80, 120, 80, 80];
    const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={1} sizeId={28} setIds="1" />);
    fireEvent.click(screen.getByTestId('next'));
    fireEvent.click(screen.getByTestId('stroke'));
    fireEvent.click(screen.getByTestId('add'));
    state.stroke = [80, 100, 73, 100];
    fireEvent.click(screen.getByTestId('stroke'));
    if (rejectOneStroke) {
      state.rejectNextFinish = true;
      state.stroke = [120, 100, 127, 100];
      fireEvent.click(screen.getByTestId('stroke'));
      expect(state.rejectNextFinish).toBe(false);
    }
    state.stroke = [100, 80, 100, 73];
    fireEvent.click(screen.getByTestId('stroke'));
    fireEvent.click(screen.getByTestId('save'));
    expect(state.save).toHaveBeenCalled();
    const outline = state.save.mock.lastCall?.[0].outline as number[];
    expect(outline.length).toBeGreaterThanOrEqual(8);
    screen.unmount();
    return outline;
  };
  expect(draw(true)).toEqual(draw(false));
});

it.each(['circle', 'outline'] as const)('only previews geometry for traced shapes: %s', (holdShape) => {
  state.holdShape = holdShape;
  const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={1} sizeId={28} setIds="1" />);
  fireEvent.click(screen.getByTestId('next'));
  expect((screen.getByTestId('preview') as HTMLButtonElement).disabled).toBe(holdShape === 'circle');
});

it.each([
  [null, 'Checking whether this build can draw traced outlines…'],
  [false, 'This build cannot preview traced outlines. Install a newer app build to preview them.'],
] as const)('explains preview availability before suggesting settings: %s', (rendererAvailable, message) => {
  state.rendererAvailable = rendererAvailable;
  const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={1} sizeId={28} setIds="1" />);
  fireEvent.click(screen.getByTestId('next'));
  expect((screen.getByTestId('preview') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(message)).toBeTruthy();
});

it('undo restores the previous saved ring, then disarms Save at the original state', () => {
  const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={1} sizeId={28} setIds="1" />);
  fireEvent.click(screen.getByTestId('next'));
  fireEvent.click(screen.getByTestId('stroke'));
  fireEvent.click(screen.getByTestId('save'));
  const firstOutline = state.save.mock.calls.at(-1)?.[0].outline;
  expect(firstOutline.length).toBeGreaterThanOrEqual(8);
  state.stroke = [78, 80, 122, 80, 122, 120, 78, 120, 78, 80];
  fireEvent.click(screen.getByTestId('stroke'));
  fireEvent.click(screen.getByTestId('save'));
  expect(state.save.mock.calls.at(-1)?.[0].outline).not.toEqual(firstOutline);

  fireEvent.click(screen.getByTestId('undo'));
  fireEvent.click(screen.getByTestId('save'));
  expect(state.save.mock.calls.at(-1)?.[0].outline).toEqual(firstOutline);
  fireEvent.click(screen.getByTestId('undo'));
  expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId('undo') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId('deselect'));
  expect(state.alert).not.toHaveBeenCalled();
});

it.each(['undo', 'discard'])('ignores a late stroke end after %s while allowing a fresh stroke', (action) => {
  const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={1} sizeId={28} setIds="1" />);
  fireEvent.click(screen.getByTestId('next'));
  fireEvent.click(screen.getByTestId('stroke'));
  fireEvent.click(screen.getByTestId('stroke-start'));
  fireEvent.click(screen.getByTestId(action));
  fireEvent.click(screen.getByTestId('stroke-end'));
  fireEvent.click(screen.getByTestId('stroke-cancel'));
  expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId('undo') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId('deselect'));
  expect(state.alert).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('next'));
  fireEvent.click(screen.getByTestId('stroke'));
  expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByTestId('save'));
  expect(state.save.mock.calls.at(-1)?.[0].outline.length).toBeGreaterThanOrEqual(8);
});

it.each([false, true])(
  'brushes the shipped inner edge with database override precedence: override=%s',
  async (withOverride) => {
    const geometry = loadBoardArtGeometry({ boardName: 'kilter', layoutId: 8, sizeId: 17 });
    const shippedInner = geometry?.ledInner?.[4117];
    expect(shippedInner?.length).toBeGreaterThanOrEqual(8);
    if (!shippedInner) throw new Error('Expected shipped Kilter Homewall inner edge');
    state.placementId = 4117;
    const override = [-0.7, -0.7, 0.7, -0.7, 0.7, 0.7, -0.7, 0.7];
    if (withOverride) {
      state.overrides = [
        { placementId: 4117, kind: 'LED_INNER', outline: override, updatedAt: '2026-09-01', authorDisplayName: null },
      ];
    }
    const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={8} sizeId={17} setIds="1" />);
    fireEvent.click(screen.getByTestId('next'));
    fireEvent.click(screen.getByTestId('inner'));
    expect((screen.getByTestId('add') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('add'));
    state.stroke = [110, 100, 124, 100];
    fireEvent.click(screen.getByTestId('stroke'));
    fireEvent.click(screen.getByTestId('save'));
    expect(state.save).toHaveBeenCalledOnce();
    const expected = brushEditOutline({
      outlineBoardPx: radiusRingToBoardPx(withOverride ? override : shippedInner, HOLD),
      strokeBoardPx: state.stroke,
      brushRadiusBoardPx: 6,
      mode: 'add',
      anchorX: HOLD.cx,
      anchorY: HOLD.cy,
      holdRadius: HOLD.r,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const finished = finishOutlineRing(expected.outlineBoardPx, HOLD);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(state.save.mock.calls[0][0]).toMatchObject({
      kind: 'LED_INNER',
      placementId: 4117,
      outline: finished.outline,
    });
    await act(async () => {});
  },
);

it('enables brushing when the browser downloads the shipped inner-edge geometry', async () => {
  const geometry = loadBoardArtGeometry({ boardName: 'kilter', layoutId: 8, sizeId: 17 });
  state.geometryPending = true;
  state.placementId = 4117;
  let finishDownload!: (result: typeof geometry) => void;
  state.prefetchGeometry.mockReturnValue(
    new Promise<typeof geometry>((resolve) => {
      finishDownload = resolve;
    }),
  );
  const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={8} sizeId={17} setIds="1" />);
  fireEvent.click(screen.getByTestId('next'));
  fireEvent.click(screen.getByTestId('inner'));
  expect((screen.getByTestId('add') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    finishDownload(geometry);
  });
  expect((screen.getByTestId('add') as HTMLButtonElement).disabled).toBe(false);
});

it('ignores a late inner-edge download after switching board size', async () => {
  const geometry = loadBoardArtGeometry({ boardName: 'kilter', layoutId: 8, sizeId: 17 });
  state.geometryPending = true;
  state.placementId = 4117;
  let finishOldDownload!: (result: typeof geometry) => void;
  state.prefetchGeometry.mockReturnValueOnce(
    new Promise<typeof geometry>((resolve) => {
      finishOldDownload = resolve;
    }),
  );
  state.prefetchGeometry.mockResolvedValueOnce(null);
  const screen = render(<OutlineCanvasScreen boardName="kilter" layoutId={8} sizeId={17} setIds="1" />);
  fireEvent.click(screen.getByTestId('next'));
  fireEvent.click(screen.getByTestId('inner'));
  screen.rerender(<OutlineCanvasScreen boardName="kilter" layoutId={8} sizeId={25} setIds="1" />);
  await act(async () => {
    finishOldDownload(geometry);
  });
  expect((screen.getByTestId('add') as HTMLButtonElement).disabled).toBe(true);
});
