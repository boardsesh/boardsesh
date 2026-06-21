// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (colorName: string) => colorName,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
vi.mock('../../src/components/ScoutPhoto', () => ({
  ScoutPhoto: () => createElement('img', { 'data-testid': 'scout-photo' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../src/lib/acknowledgements', () => ({ dogName: 'Scout' }));
vi.mock('../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 80 }),
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666' } }),
}));

import ScoutScreen from '../scout';

describe('ScoutScreen', () => {
  it('shows the photo and names the dog', () => {
    render(<ScoutScreen />);

    expect(screen.getByTestId('scout-photo')).toBeTruthy();
    expect(screen.getByText('Scout')).toBeTruthy();
  });
});
