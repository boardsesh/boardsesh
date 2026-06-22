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
  Image: ({ source, recyclingKey }: { source: { uri: string }; recyclingKey?: string }) =>
    createElement('img', { src: source.uri, 'data-recycling-key': recyclingKey ?? '' }),
}));

vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

import { LayeredClimbImage } from '../LayeredClimbImage';

describe('LayeredClimbImage recyclingKey', () => {
  it('forwards recyclingKey to the overlay image so swaps release the old bitmap', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/bg.webp'],
        recyclingKey: 'frames-abc',
      }),
    );
    const overlay = container.querySelector('img[src="file:///overlay.png"]');
    expect(overlay?.getAttribute('data-recycling-key')).toBe('frames-abc');
  });

  it('does not apply recyclingKey to the shared background image', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/bg.webp'],
        recyclingKey: 'frames-abc',
      }),
    );
    // The board photo is shared per board-config (keyed by path), so it must not
    // recycle on every climb change.
    const background = container.querySelector('img[src="file:///bg.webp"]');
    expect(background?.getAttribute('data-recycling-key')).toBe('');
  });
});
