// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';

// #5960: on a wall that is not public, "Not at a gym" promised a pin of its
// own; and a tap on a search result only dismissed the keyboard.

type ListProps = { keyboardShouldPersistTaps?: string; data: { uuid: string; name: string }[] };
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => null,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(function BottomSheetModalMock({ children }: { children?: ReactNode }, _ref) {
    return createElement('div', null, children);
  }),
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetTextInput: () => createElement('input'),
  BottomSheetFlatList: ({ keyboardShouldPersistTaps, data }: ListProps) =>
    createElement(
      'ul',
      { 'data-testid': 'gym-list', 'data-persist-taps': keyboardShouldPersistTaps ?? '' },
      data.map((gym) => createElement('li', { key: gym.uuid }, gym.name)),
    ),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useNearbyGyms: () => ({ data: { gyms: [{ uuid: 'gym-1', name: 'Crag Hall' }] }, isLoading: false }),
}));
vi.mock('../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: 'granted', coords: null, request: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({ onChange: vi.fn(), onFullyDismissed: vi.fn() }),
}));
vi.mock('../../sheet-snap-points', () => ({ androidSafeSnapPoints: (points: string[]) => points }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#fff', secondaryLabel: '#888', tertiaryLabel: '#666', tertiaryBackground: '#222' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 8 } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8E8E93' } }));

import { GymPickerSheet } from '../GymPickerSheet';

function renderSheet(showsOnMap?: boolean) {
  return render(
    <GymPickerSheet
      selectedUuid={null}
      boardCoords={{ latitude: 1, longitude: 2 }}
      onSelect={vi.fn()}
      showsOnMap={showsOnMap}
      onRequestManualLocation={vi.fn()}
      onDismiss={vi.fn()}
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
});
