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
  Image: ({
    source,
    testID,
    transition,
    recyclingKey,
  }: {
    source: { uri: string };
    testID?: string;
    transition?: number;
    recyclingKey?: string;
  }) =>
    createElement('img', {
      src: source.uri,
      'data-testid': testID ?? 'expo-image',
      'data-transition': transition,
      'data-recycling-key': recyclingKey,
    }),
}));

// These tests exercise the foregrounded render path; the backgrounded blank is
// covered in layered-climb-image-backgrounded.test.tsx.
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

import { LayeredClimbImage } from '../LayeredClimbImage';

describe('LayeredClimbImage', () => {
  it('renders a visible backing layer when no image layer is available yet', () => {
    const { container } = render(createElement(LayeredClimbImage, { overlayUri: null, backgroundPaths: [] }));

    expect(container.querySelector('[data-testid="layered-climb-image-empty-fallback"]')).toBeTruthy();
  });

  it('keeps the backing layer behind an overlay when the background is unavailable', () => {
    const { container } = render(
      createElement(LayeredClimbImage, { overlayUri: 'file:///overlay.png', backgroundPaths: [] }),
    );

    expect(container.querySelector('[data-testid="layered-climb-image-empty-fallback"]')).toBeTruthy();
    expect(container.querySelector('img[src="file:///overlay.png"]')).toBeTruthy();
  });

  it('does not render the empty backing layer when a real background path is present', () => {
    const { container } = render(
      createElement(LayeredClimbImage, { overlayUri: null, backgroundPaths: ['/bundled/kilter.webp'] }),
    );

    expect(container.querySelector('[data-testid="layered-climb-image-empty-fallback"]')).toBeNull();
    expect(container.querySelector('img[src="file:///bundled/kilter.webp"]')).toBeTruthy();
  });

  it('lets missing-background placeholders own the fallback state', () => {
    const { container } = render(
      createElement(LayeredClimbImage, { overlayUri: null, backgroundPaths: [], missingBackgroundCount: 1 }),
    );

    expect(container.querySelector('[data-testid="layered-climb-image-empty-fallback"]')).toBeNull();
  });

  it('cross-fades the holds overlay by default', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/bundled/kilter.webp'],
      }),
    );

    expect(container.querySelector('img[src="file:///overlay.png"]')?.getAttribute('data-transition')).toBe('150');
  });

  it('swaps the holds overlay instantly when suppressOverlayTransition is set (no end-of-swipe flash)', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/bundled/kilter.webp'],
        suppressOverlayTransition: true,
      }),
    );

    expect(container.querySelector('img[src="file:///overlay.png"]')?.getAttribute('data-transition')).toBe('0');
  });

  it('forwards recyclingKey to the holds-overlay <Image> so the carousel recycles on climb change', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/bundled/kilter.webp'],
        recyclingKey: 'climb-frames-abc',
      }),
    );

    const overlay = container.querySelector('img[src="file:///overlay.png"]');
    expect(overlay?.getAttribute('data-recycling-key')).toBe('climb-frames-abc');
  });
});
