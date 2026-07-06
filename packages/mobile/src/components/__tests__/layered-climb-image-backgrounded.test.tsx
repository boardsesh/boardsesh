// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; testID?: string };

vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
}));

// Force the backgrounded branch.
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => true }));

import { LayeredClimbImage } from '../LayeredClimbImage';

describe('LayeredClimbImage (backgrounded)', () => {
  it('drops every image layer while the app is backgrounded', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/bundled/kilter.webp'],
      }),
    );

    // No decoded bitmaps mounted while backgrounded — the whole stack is blank.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="layered-climb-image-empty-fallback"]')).toBeNull();
  });
});
