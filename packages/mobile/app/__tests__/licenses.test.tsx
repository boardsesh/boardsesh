// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { OssLicense } from '../../src/lib/oss-licenses';

const openUrl = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (colorName: string) => colorName,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('div', { 'data-testid': 'license-modal' }, children) : null,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
  }: {
    data: OssLicense[];
    renderItem: (info: { item: OssLicense }) => ReactNode;
    keyExtractor: (item: OssLicense) => string;
    ListHeaderComponent?: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      ...data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    ),
}));

vi.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'mobile.licenses.viewSource': 'View source',
        'mobile.licenses.title': 'Open source licenses',
      })[key] ?? key,
  }),
}));

vi.mock('../../src/lib/oss-licenses', () => ({
  loadOssLicenses: () =>
    Promise.resolve([
      {
        name: 'react',
        version: '19.0.0',
        license: 'MIT',
        repository: 'https://github.com/facebook/react',
        publisher: 'Meta',
        licenseText: 'MIT License — permission is hereby granted',
      },
      { name: 'zod', version: '3.0.0', license: 'MIT', repository: null, publisher: null, licenseText: null },
    ]),
}));
vi.mock('../../src/lib/open-url', () => openUrl);
vi.mock('../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'licenses-loading' }),
}));

vi.mock('../../src/components/Button', () => ({
  Button: ({ onPress, title }: { onPress: () => void; title: string }) =>
    createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../src/components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));
vi.mock('../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 80 }),
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      accent: '#6D28D9',
      background: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#333',
    },
  }),
}));

import LicensesScreen from '../licenses';

beforeEach(() => {
  openUrl.openExternalUrl.mockClear();
});

describe('LicensesScreen', () => {
  it('lists each bundled package once the manifest loads', async () => {
    render(<LicensesScreen />);

    // The list appears only after the lazy loadOssLicenses() resolves.
    expect(await screen.findByText('react')).toBeTruthy();
    expect(screen.getByText('zod')).toBeTruthy();
  });

  it('opens a package and shows its full license text, then opens the source', async () => {
    render(<LicensesScreen />);

    expect(screen.queryByTestId('license-modal')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'react' }));

    expect(screen.getByTestId('license-modal')).toBeTruthy();
    expect(screen.getByText('MIT License — permission is hereby granted')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View source' }));

    expect(openUrl.openExternalUrl).toHaveBeenCalledWith('https://github.com/facebook/react', 'license-source');
  });

  it('hides View source for a package with no repository', async () => {
    render(<LicensesScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'zod' }));

    expect(screen.getByTestId('license-modal')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View source' })).toBeNull();
  });
});
