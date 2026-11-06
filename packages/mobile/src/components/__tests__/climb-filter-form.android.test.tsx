// @vitest-environment jsdom
import { createElement, createRef, forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';
import type { ClimbFilterFormModel } from '../ClimbFilterForm.types';
import type { ClimbFilterFormHandle } from '../ClimbFilterForm.android';
vi.hoisted(() => {
  const nodeModule = process.getBuiltinModule('node:module') as unknown as {
    _extensions: Record<string, (module: { exports: unknown }, filename: string) => void>;
  };
  nodeModule._extensions['.xml'] = (module, filename) => {
    module.exports = filename;
  };
});
const native = vi.hoisted(() => ({
  column: null as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null,
  columnPosition: vi.fn(),
  rowPosition: vi.fn(),
  center: vi.fn(),
  name: null as Record<string, unknown> | null,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
  Keyboard: { dismiss: vi.fn() },
}));
vi.mock('../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'font' }) }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { grade?: string }) => (params?.grade ? `${key}:${params.grade}` : key),
  }),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#fff', fill: '#222' },
    chartColors: { label: '#fff' },
    brandColors: { primary: '#aaa' },
  }),
}));
vi.mock('../../theme/expo-ui-modifiers', () => ({ textFieldBrandColors: () => ({}) }));
vi.mock('../settings-rows.android', () => ({
  useSettingsRowColors: () => ({ sectionTextColor: '#aaa' }),
  renderSettingsRow: (row: { key: string; label?: string }) => createElement('div', { key: row.key }, row.label),
}));
type Modifier = { kind: string; arguments: unknown[] };
vi.mock('@expo/ui/jetpack-compose/modifiers', () => {
  const modifier =
    (kind: string) =>
    (...arguments_: unknown[]) => ({ kind, arguments: arguments_ });
  return {
    ...Object.fromEntries(
      [
        'background',
        'border',
        'clip',
        'combinedClickable',
        'defaultMinSize',
        'fillMaxWidth',
        'height',
        'padding',
        'semantics',
        'weight',
      ].map((name) => [name, modifier(name)]),
    ),
    Shapes: { RoundedCorner: () => ({}) },
  };
});
vi.mock('@expo/ui/jetpack-compose', () => {
  const Container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const TextField = Object.assign(
    (props: Record<string, unknown> & { children?: ReactNode }) => {
      native.name = props;
      return createElement('div', null, props.children);
    },
    { Label: Container, Placeholder: Container, TrailingIcon: Container },
  );
  return {
    Card: Container,
    Column: Container,
    Text: Container,
    Icon: () => null,
    IconButton: Container,
    OutlinedTextField: TextField,
    useNativeState: (text: string) => {
      const state = useRef({ set: vi.fn(), value: text });
      return state.current;
    },
    Box: ({ children, modifiers }: { children?: ReactNode; modifiers: Modifier[] }) => {
      const gesture = modifiers.find((modifier) => modifier.kind === 'combinedClickable')?.arguments[0] as {
        onClick: () => void;
        onLongClick?: () => void;
      };
      const state = modifiers.find((modifier) => modifier.kind === 'semantics')?.arguments[0] as { selected: boolean };
      return createElement(
        'button',
        { onClick: gesture.onClick, onContextMenu: gesture.onLongClick, 'aria-pressed': state.selected },
        children,
      );
    },
    LazyColumn: forwardRef((props: Record<string, unknown> & { children?: ReactNode }, ref) => {
      native.column = props;
      useImperativeHandle(ref, () => ({ getScrollPosition: native.columnPosition }));
      return createElement('div', null, props.children);
    }),
    LazyRow: forwardRef((props: Record<string, unknown> & { children?: ReactNode }, ref) => {
      native.row = props;
      useImperativeHandle(ref, () => ({ getScrollPosition: native.rowPosition, scrollToItem: native.center }));
      return createElement('div', null, props.children);
    }),
  };
});
import { ClimbFilterForm } from '../ClimbFilterForm.android';
const grades: Grade[] = [
  { difficultyId: 12, name: '4c' },
  { difficultyId: 16, name: '6a' },
  { difficultyId: 18, name: '6b' },
];
function model(bound: Partial<GradeBound>, onChange = vi.fn()): ClimbFilterFormModel {
  return {
    sections: [
      {
        key: 'name',
        title: 'Name',
        rows: [
          {
            kind: 'name',
            key: 'name',
            value: '',
            placeholder: 'Climb name',
            accessibilityLabel: 'Name',
            clearLabel: 'Clear',
            onChangeText: vi.fn(),
            onClear: vi.fn(),
            onFocus: vi.fn(),
          },
        ],
      },
      {
        key: 'difficulty',
        title: 'Difficulty',
        rows: [
          {
            kind: 'grade',
            key: 'grade',
            height: 72,
            grade: {
              grades,
              bound: { minGradeId: bound.minGradeId, maxGradeId: bound.maxGradeId },
              onChange,
              lastUsedGradeId: 16,
            },
          },
        ],
      },
      { key: 'sort', title: 'Sort', rows: [] },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  native.center.mockResolvedValue(undefined);
  native.columnPosition.mockResolvedValue({ index: 2, offsetDp: 14 });
  native.rowPosition.mockResolvedValue({ index: 1, offsetDp: 8 });
});
afterEach(cleanup);
describe('Android native filter form', () => {
  it('restores by section identity after preceding sections change', () => {
    const current = model({});
    current.sections.shift();
    render(
      <ClimbFilterForm
        model={current}
        onNameFocus={vi.fn()}
        initialScrollPosition={{ sectionKey: 'sort', offsetDp: 14, rail: { index: 1, offsetDp: 8 } }}
      />,
    );
    expect(native.column?.initialScrollPosition).toEqual({ index: 1, offsetDp: 14 });
    expect(native.row?.initialScrollPosition).toEqual({ index: 1, offsetDp: 8 });
    expect(native.center).not.toHaveBeenCalled();
  });
  it('snapshots native positions using a stable section key', async () => {
    const ref = createRef<ClimbFilterFormHandle>();
    render(<ClimbFilterForm ref={ref} model={model({})} onNameFocus={vi.fn()} />);
    await expect(ref.current?.captureScrollPosition()).resolves.toEqual({
      sectionKey: 'sort',
      offsetDp: 14,
      rail: { index: 1, offsetDp: 8 },
    });
  });
  it('retains its last snapshot when a handler rejects', async () => {
    const ref = createRef<ClimbFilterFormHandle>();
    render(<ClimbFilterForm ref={ref} model={model({})} onNameFocus={vi.fn()} />);
    const snapshot = await ref.current?.captureScrollPosition();
    native.columnPosition.mockRejectedValue(new Error('disposed'));
    await expect(ref.current?.captureScrollPosition()).resolves.toEqual(snapshot);
  });
  it('expands on field focus without auto-focusing the field', () => {
    const focus = vi.fn();
    render(<ClimbFilterForm model={model({})} onNameFocus={focus} />);
    expect(native.name?.autoFocus).not.toBe(true);
    const onFocusChanged = native.name?.onFocusChanged;
    if (typeof onFocusChanged !== 'function') throw new Error('Expected native name focus handler');
    act(() => onFocusChanged(true));
    expect(focus).toHaveBeenCalledOnce();
  });
  it('preserves tap, timed extension, hold and Any without recentering own edits', async () => {
    const change = vi.fn();
    const current = model({}, change);
    const view = render(<ClimbFilterForm model={current} onNameFocus={vi.fn()} />);
    await act(async () => {});
    native.center.mockClear();
    fireEvent.click(view.getByRole('button', { name: '6A' }));
    expect(change).toHaveBeenLastCalledWith({ minGradeId: 16, maxGradeId: 16 }, { gesture: 'tap' });
    view.rerender(<ClimbFilterForm model={model({ minGradeId: 16, maxGradeId: 16 }, change)} onNameFocus={vi.fn()} />);
    fireEvent.click(view.getByRole('button', { name: '6B' }));
    expect(change).toHaveBeenLastCalledWith(
      { minGradeId: 16, maxGradeId: 18 },
      { gesture: 'tap', withinRangeWindow: true },
    );
    view.rerender(<ClimbFilterForm model={model({ minGradeId: 16, maxGradeId: 18 }, change)} onNameFocus={vi.fn()} />);
    fireEvent.contextMenu(view.getByRole('button', { name: '4C' }));
    expect(change).toHaveBeenLastCalledWith({ minGradeId: 12, maxGradeId: 18 }, { gesture: 'hold' });
    view.rerender(<ClimbFilterForm model={model({ minGradeId: 12, maxGradeId: 18 }, change)} onNameFocus={vi.fn()} />);
    fireEvent.click(view.getByRole('button', { name: 'mobile.search.gradeClear' }));
    expect(change).toHaveBeenLastCalledWith({ minGradeId: undefined, maxGradeId: undefined }, { gesture: 'clear' });
    expect(native.center).not.toHaveBeenCalled();
  });
  it('recenters Reset even when the selected and default grade share an index', async () => {
    const view = render(<ClimbFilterForm model={model({ minGradeId: 16, maxGradeId: 16 })} onNameFocus={vi.fn()} />);
    await act(async () => {});
    native.center.mockClear();
    view.rerender(<ClimbFilterForm model={model({})} onNameFocus={vi.fn()} />);
    await act(async () => {});
    expect(native.center).toHaveBeenCalledExactlyOnceWith({
      index: 2,
      alignment: 'center',
      requestId: 2,
      allowAfterInteraction: true,
    });
  });
  it('centers external grade selections and exposes their selected state', async () => {
    const view = render(<ClimbFilterForm model={model({ minGradeId: 16, maxGradeId: 16 })} onNameFocus={vi.fn()} />);
    await act(async () => {});
    expect(native.center).toHaveBeenLastCalledWith({ index: 2, alignment: 'center', requestId: 1 });
    expect(view.getByRole('button', { name: '6A' }).getAttribute('aria-pressed')).toBe('true');
    view.rerender(<ClimbFilterForm model={model({ minGradeId: 18, maxGradeId: 18 })} onNameFocus={vi.fn()} />);
    await act(async () => {});
    expect(native.center).toHaveBeenLastCalledWith({
      index: 3,
      alignment: 'center',
      requestId: 2,
      allowAfterInteraction: true,
    });
  });
});
