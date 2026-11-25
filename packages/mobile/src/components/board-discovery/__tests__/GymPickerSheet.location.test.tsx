// @vitest-environment jsdom
vi.mock('../../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The sheet with the real location hook: once only Settings can turn location
// on, "Use my location" opens Settings, and coming back reads the permission
// again. Without that read the next tap went back to Settings in a loop.

const appState = vi.hoisted(() => ({ listeners: new Set<(next: string) => void>() }));
const openSettingsMock = vi.hoisted(() => vi.fn(async () => {}));
const nearbyGymsMock = vi.hoisted(() =>
  vi.fn((_coords: unknown, _radius: number, _search: string) => ({ data: { gyms: [] }, isLoading: false })),
);
const expoLocation = vi.hoisted(() => ({
  getForegroundPermissionsAsync: vi.fn(),
  requestForegroundPermissionsAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
  Accuracy: { Balanced: 3 },
}));

vi.mock('expo-location', () => expoLocation);
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openSettings: openSettingsMock },
  AppState: {
    addEventListener: (_type: string, listener: (next: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
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
  BottomSheetFlatList: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useNearbyGyms: (coords: unknown, radius: number, search: string) => nearbyGymsMock(coords, radius, search),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header }: { children?: ReactNode; header?: ReactNode }) =>
    createElement('div', null, header, children),
}));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
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

beforeEach(() => {
  appState.listeners.clear();
  openSettingsMock.mockClear();
  nearbyGymsMock.mockClear();
  expoLocation.getForegroundPermissionsAsync.mockReset();
  expoLocation.requestForegroundPermissionsAsync.mockReset();
  expoLocation.getCurrentPositionAsync.mockReset().mockResolvedValue({ coords: { latitude: 51.5, longitude: -0.1 } });
});

function renderSheet(boardCoords: { latitude: number; longitude: number } | null) {
  return render(
    <GymPickerSheet
      selectedUuid={null}
      boardCoords={boardCoords}
      onSelect={vi.fn()}
      onRequestManualLocation={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

describe('GymPickerSheet location', () => {
  it('never shows the system prompt on open', async () => {
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    const { getByText } = renderSheet(null);
    await waitFor(() => expect(expoLocation.getForegroundPermissionsAsync).toHaveBeenCalled());
    expect(expoLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(getByText('mobile.gyms.grantLocation')).toBeTruthy();
  });

  it('loads nearby gyms after a grant in Settings, with no second tap', async () => {
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    const { getByText } = renderSheet(null);
    await waitFor(() => expect(expoLocation.getForegroundPermissionsAsync).toHaveBeenCalledOnce());

    // Blocked: the button opens Settings rather than a dead prompt.
    await act(async () => getByText('mobile.gyms.grantLocation').click());
    expect(openSettingsMock).toHaveBeenCalledOnce();
    expect(expoLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    // Location turned on in Settings, then back to the app.
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });
    // Already granted, so the system answers at once with no prompt.
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });
    await act(async () => {
      for (const listener of appState.listeners) listener('active');
    });

    await waitFor(() => expect(nearbyGymsMock).toHaveBeenLastCalledWith({ latitude: 51.5, longitude: -0.1 }, 50, ''));
  });

  it('does not listen for the app coming back when the board already has coordinates', () => {
    expoLocation.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    renderSheet({ latitude: 1, longitude: 2 });
    expect(appState.listeners.size).toBe(0);
    expect(expoLocation.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});
