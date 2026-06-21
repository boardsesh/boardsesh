// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';

type SetterStat = { setterUsername: string; climbCount: number };
type CapturedFlatListProps = { renderItem: unknown; extraData: unknown };

const flatListSnapshots = vi.hoisted<CapturedFlatListProps[]>(() => []);
const hookState = vi.hoisted(() => ({
  setters: [
    { setterUsername: 'alice', climbCount: 12 },
    { setterUsername: 'bob', climbCount: 4 },
  ] satisfies SetterStat[],
  isLoading: false,
  enabledCalls: [] as boolean[],
}));

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { checked?: boolean };
};

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState }: PressableMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-label': accessibilityLabel ?? '',
        'data-role': accessibilityRole ?? '',
        'data-checked': accessibilityState?.checked ? 'true' : 'false',
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  TextInput: ({ value, placeholder }: { value?: string; placeholder?: string }) =>
    createElement('input', { value: value ?? '', placeholder: placeholder ?? '', readOnly: true }),
}));

type BottomSheetFlatListMockProps = {
  data?: SetterStat[];
  extraData?: unknown;
  renderItem: (args: { item: SetterStat }) => ReactNode;
  keyExtractor?: (item: SetterStat) => string;
};

vi.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetFlatList: ({ data = [], extraData, renderItem, keyExtractor }: BottomSheetFlatListMockProps) => {
    flatListSnapshots.push({ renderItem, extraData });
    return createElement(
      'div',
      { 'data-flat-list': 'true' },
      data.map((item) =>
        createElement('div', { key: keyExtractor?.(item) ?? item.setterUsername }, renderItem({ item })),
      ),
    );
  },
}));

vi.mock('../../ModalSheet', () => ({
  ModalSheet: forwardRef<unknown, { children?: ReactNode }>(function ModalSheetMock({ children }, _ref) {
    return createElement('div', { 'data-sheet': 'true' }, children);
  }),
}));

vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111', secondaryBackground: '#EEE' },
    brandColors: { primary: '#2563EB' },
  }),
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useSetterStats: (_queryInput: unknown, enabled: boolean) => {
    hookState.enabledCalls.push(enabled);
    return { data: hookState.setters, isLoading: hookState.isLoading };
  },
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { separator: '#DDD', systemGray: '#888' },
}));

vi.mock('../../../theme/typography', () => ({
  textStyles: { callout: { fontSize: 16 } },
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: { count?: number }) => `${key}${values?.count ?? ''}` }),
}));

import { SettersFilterSheet } from '../SettersFilterSheet';

const boardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

describe('SettersFilterSheet', () => {
  beforeEach(() => {
    flatListSnapshots.length = 0;
    hookState.isLoading = false;
    hookState.enabledCalls = [];
  });

  it('keeps renderRow stable while selection changes through extraData', () => {
    const onSelectedSettersChange = vi.fn();
    const view = render(
      <SettersFilterSheet
        visible
        boardConfig={boardConfig}
        selectedSetters={[]}
        onSelectedSettersChange={onSelectedSettersChange}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const firstRenderItem = flatListSnapshots.at(-1)?.renderItem;
    expect(view.container.querySelector('[data-label="alice"]')?.getAttribute('data-checked')).toBe('false');

    view.rerender(
      <SettersFilterSheet
        visible
        boardConfig={boardConfig}
        selectedSetters={['alice']}
        onSelectedSettersChange={onSelectedSettersChange}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(flatListSnapshots.at(-1)?.renderItem).toBe(firstRenderItem);
    expect(flatListSnapshots.at(-1)?.extraData).toEqual(['alice']);
    expect(view.container.querySelector('[data-label="alice"]')?.getAttribute('data-checked')).toBe('true');

    fireEvent.click(view.container.querySelector('[data-label="alice"]') as HTMLButtonElement);
    expect(onSelectedSettersChange).toHaveBeenLastCalledWith([]);
  });

  it('disables the setter query without a board name', () => {
    render(
      <SettersFilterSheet
        visible
        boardConfig={{ ...boardConfig, boardName: '' as typeof boardConfig.boardName }}
        selectedSetters={[]}
        onSelectedSettersChange={vi.fn()}
        onClose={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(hookState.enabledCalls.at(-1)).toBe(false);
  });
});
