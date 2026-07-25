// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; testID?: string };

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  // theme/colors.ts (imported by LayeredClimbImage for resolveMoonboardBackdrop)
  // computes iosSystemColors at module-load time via PlatformColor — must be
  // stubbed or the import throws before any test body runs.
  PlatformColor: (colorName: string) => colorName,
  useColorScheme: () => 'light',
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// LayeredClimbImage reads the backdrop preset via useSetting('moonboardBackdrop')
// (MMKV-backed) — mock the settings module directly rather than react-native-mmkv.
vi.mock('../../settings', () => ({
  useSetting: () => ['gold', vi.fn()],
}));

vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
}));

// Foregrounded: isolate the surface-hidden lever (the inactive-iPad-tab case) from
// the app-background one covered in layered-climb-image-backgrounded.test.tsx.
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

import { LayeredClimbImage } from '../LayeredClimbImage';
import { BoardArtVisibilityContext } from '../board-art-visibility-context';

describe('LayeredClimbImage (surface hidden)', () => {
  it('drops every image layer when the board-art surface is not visible', () => {
    const { container } = render(
      createElement(
        BoardArtVisibilityContext.Provider,
        { value: false },
        createElement(LayeredClimbImage, {
          overlayUri: 'file:///overlay.png',
          backgroundPaths: ['/bundled/kilter.webp'],
        }),
      ),
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="layered-climb-image-empty-fallback"]')).toBeNull();
  });

  it('renders the layers when the surface is visible', () => {
    const { container } = render(
      createElement(
        BoardArtVisibilityContext.Provider,
        { value: true },
        createElement(LayeredClimbImage, {
          overlayUri: 'file:///overlay.png',
          backgroundPaths: ['/bundled/kilter.webp'],
        }),
      ),
    );

    expect(container.querySelector('img[src="file:///overlay.png"]')).toBeTruthy();
  });
});
