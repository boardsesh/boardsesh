// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stroke: [80, 80, 120, 80, 120, 120, 80, 120, 80, 80],
  save: vi.fn(),
  holdShape: 'outline' as 'outline' | 'circle',
  rejectNextFinish: false,
  rendererAvailable: true as boolean | null,
}));
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
    Alert: { alert: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
  };
});
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', label: '#000' } }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useHoldOutlines: () => ({ data: { shardOutlines: [], overrides: [] }, isLoading: false }),
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
  getCreateBoardHolds: () => ({ boardWidth: 200, boardHeight: 200, holdTargets: [HOLD] }),
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
  const { Pressable } = await import('react-native');
  return {
    DrawStrokeOverlay: (props: { onStrokeStart: () => void; onStrokeEnd: (points: number[]) => void }) =>
      createElement(Pressable, {
        testID: 'stroke',
        onPress: () => {
          props.onStrokeStart();
          props.onStrokeEnd(state.stroke);
        },
      }),
  };
});
vi.mock('../EditToolbar', async () => {
  const { createElement } = await import('react');
  const { Pressable, Text: MockText, View: MockView } = await import('react-native');
  return {
    EditToolbar: (props: {
      onNextPlacement: () => void;
      onDrawModeChange: (mode: 'add') => void;
      onSave: () => void;
      canBrush: boolean;
      previewAvailable: boolean;
      previewUnavailableNote?: string;
    }) =>
      createElement(
        MockView,
        null,
        createElement(Pressable, { testID: 'next', onPress: props.onNextPlacement }),
        createElement(Pressable, {
          testID: 'add',
          disabled: !props.canBrush,
          onPress: () => props.onDrawModeChange('add'),
        }),
        createElement(Pressable, { testID: 'save', onPress: props.onSave }),
        createElement(Pressable, { testID: 'preview', disabled: !props.previewAvailable }),
        createElement(MockText, null, props.previewUnavailableNote),
      ),
  };
});

import { OutlineCanvasScreen } from '../OutlineCanvasScreen';

beforeEach(() => {
  state.save.mockClear();
  state.holdShape = 'outline';
  state.rejectNextFinish = false;
  state.rendererAvailable = true;
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
