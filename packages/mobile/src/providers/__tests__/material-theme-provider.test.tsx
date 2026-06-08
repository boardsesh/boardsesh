// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Material3Scheme } from '@pchmn/expo-material3-theme';

const dynamicMaterialColors = vi.hoisted(() => ({ primary: '#3366AA' }) as unknown as Material3Scheme);

type BuildPaperThemeMock = (colorScheme: string, dynamicPalette?: Material3Scheme) => { colors: { primary: string } };

const buildPaperThemeMock = vi.hoisted(() =>
  vi.fn<BuildPaperThemeMock>(() => ({ colors: { primary: '#3366AA' } })),
);

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: () => createElement('span', { 'data-icon': 'material-community' }),
}));

vi.mock('react-native-paper', () => ({
  PaperProvider: ({ children }: { children: ReactNode }) => createElement('div', { 'data-paper': 'provider' }, children),
}));

vi.mock('../theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'dark', dynamicMaterialColors }),
}));

vi.mock('../../theme/paper-theme', () => ({
  buildPaperTheme: (colorScheme: string, dynamicPalette?: Material3Scheme) =>
    buildPaperThemeMock(colorScheme, dynamicPalette),
}));

import { MaterialThemeProvider } from '../material-theme-provider';

describe('MaterialThemeProvider', () => {
  it('passes dynamic Material colors into the Paper theme builder', () => {
    render(
      <MaterialThemeProvider>
        <span>child</span>
      </MaterialThemeProvider>,
    );

    expect(buildPaperThemeMock).toHaveBeenCalledWith('dark', dynamicMaterialColors);
  });
});
