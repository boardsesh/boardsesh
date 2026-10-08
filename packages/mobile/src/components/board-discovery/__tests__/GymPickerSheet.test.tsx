// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5960: on a wall that is not public, "Not at a gym" promised a pin of its
// own; and a tap on a search result only dismissed the keyboard.

type ListProps = { keyboardShouldPersistTaps?: string; data: { uuid: string; name: string }[] };
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('div', { role: 'button', onClick: onPress }, children),
  ActivityIndicator: () => null,
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: () => createElement('input'),
  BottomSheetFlatList: ({ keyboardShouldPersistTaps, data }: ListProps) =>
    createElement(
      'ul',
      { 'data-testid': 'gym-list', 'data-persist-taps': keyboardShouldPersistTaps ?? '' },
      data.map((gym) => createElement('li', { key: gym.uuid }, gym.name)),
    ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useNearbyGyms: () => ({ data: { gyms: [{ uuid: 'gym-1', name: 'Crag Hall' }] }, isLoading: false }),
}));
vi.mock('../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: 'granted', coords: null, request: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header }: { children?: ReactNode; header?: ReactNode }) =>
    createElement('div', null, header, children),
}));
type TopBarMockProps = { title: string; leading?: { kind: string; onPress: () => void } };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: TopBarMockProps) =>
    createElement(
      'div',
      null,
      title,
      leading ? createElement('button', { 'data-testid': `leading-${leading.kind}`, onClick: leading.onPress }) : null,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { label: '#fff', secondaryLabel: '#888', tertiaryLabel: '#666', tertiaryBackground: '#222' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));

import { GymPickerSheet } from '../GymPickerSheet';

function renderSheet(
  showsOnMap?: boolean,
  handlers: { onRequestManualLocation?: () => void; onDismiss?: () => void } = {},
) {
  return render(
    <GymPickerSheet
      selectedUuid={null}
      boardCoords={{ latitude: 1, longitude: 2 }}
      onSelect={vi.fn()}
      showsOnMap={showsOnMap}
      onRequestManualLocation={handlers.onRequestManualLocation ?? vi.fn()}
      onDismiss={handlers.onDismiss ?? vi.fn()}
    />,
  );
}

describe('GymPickerSheet', () => {
  it('promises a pin of its own for a board on the map', () => {
    const { getByText } = renderSheet(true);
    expect(getByText('mobile.gymPicker.noGymHint')).toBeTruthy();
  });

  it('says it stays off the map for a board that is not public', () => {
    const { getByText, queryByText } = renderSheet(false);
    expect(getByText('mobile.gymPicker.noGymHintOffMap')).toBeTruthy();
    expect(queryByText('mobile.gymPicker.noGymHint')).toBeNull();
  });

  it('lets the first tap on a result land while the keyboard is up', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('gym-list').getAttribute('data-persist-taps')).toBe('handled');
  });

  it('closes from the top bar', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = renderSheet(true, { onDismiss });
    act(() => getByTestId('leading-close').click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('offers "My gym isn\'t listed" as a row next to "Not at a gym"', () => {
    const onRequestManualLocation = vi.fn();
    const { getByText } = renderSheet(true, { onRequestManualLocation });
    act(() => getByText('mobile.gymPicker.addNew').click());
    expect(onRequestManualLocation).toHaveBeenCalledOnce();
  });
});
