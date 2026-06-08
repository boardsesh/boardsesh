type StubMaterial3Scheme = {
  primary: string;
  onPrimary: string;
  background: string;
  onSurface: string;
  onSurfaceVariant: string;
  outlineVariant: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  elevation: { level2: string };
};

type StubMaterial3Theme = {
  light: StubMaterial3Scheme;
  dark: StubMaterial3Scheme;
};

const fallbackTheme: StubMaterial3Theme = {
  light: {
    primary: '#6D28D9',
    onPrimary: '#FFFFFF',
    background: '#F3EFFA',
    onSurface: '#000000',
    onSurfaceVariant: 'rgba(60, 60, 67, 0.6)',
    outlineVariant: 'rgba(60, 60, 67, 0.18)',
    surfaceContainerLow: '#FFFFFF',
    surfaceContainer: '#FFFFFF',
    elevation: { level2: '#FFFFFF' },
  },
  dark: {
    primary: '#7C3AED',
    onPrimary: '#FFFFFF',
    background: '#15101E',
    onSurface: '#FFFFFF',
    onSurfaceVariant: 'rgba(235, 235, 245, 0.6)',
    outlineVariant: 'rgba(235, 235, 245, 0.18)',
    surfaceContainerLow: '#221A33',
    surfaceContainer: '#2A2142',
    elevation: { level2: '#2A2142' },
  },
};

export const isDynamicThemeSupported = false;

export function useMaterial3Theme() {
  return {
    theme: fallbackTheme,
    updateTheme: () => undefined,
    resetTheme: () => undefined,
  };
}

export function createMaterial3Theme() {
  return fallbackTheme;
}
