// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; testID?: string };
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  // theme/colors.ts (imported for moonboardWallBackdrop) computes
  // iosSystemColors at module-load time via PlatformColor — must be stubbed
  // or the import throws before any test body runs.
  PlatformColor: (colorName: string) => colorName,
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

  it('keeps browser asset URLs loadable instead of turning them into file URLs', () => {
    platform.os = 'web';
    const { container } = render(
      createElement(LayeredClimbImage, { overlayUri: null, backgroundPaths: ['/assets/kilter.webp'] }),
    );

    expect(container.querySelector('img[src="/assets/kilter.webp"]')).toBeTruthy();
    platform.os = 'ios';
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

  // MoonBoard board art (moonboard-bg + holdset webps) is a near-fully-transparent
  // schematic with no filled wall behind it, so without a fixed backdrop dark-mode
  // chrome shows through and swallows the holds (issue #3885, #1449).
  describe('MoonBoard backdrop (issue #3885)', () => {
    it('paints the fixed backdrop layer for boardName="moonboard"', () => {
      const { container } = render(
        createElement(LayeredClimbImage, {
          overlayUri: null,
          backgroundPaths: ['/bundled/moonboard-bg.webp', '/bundled/holdseta.webp'],
          boardName: 'moonboard',
        }),
      );

      expect(container.querySelector('[data-testid="layered-climb-image-moonboard-backdrop"]')).toBeTruthy();
    });

    it('does not paint the backdrop for other boards', () => {
      const { container } = render(
        createElement(LayeredClimbImage, {
          overlayUri: null,
          backgroundPaths: ['/bundled/kilter.webp'],
          boardName: 'kilter',
        }),
      );

      expect(container.querySelector('[data-testid="layered-climb-image-moonboard-backdrop"]')).toBeNull();
    });

    it('does not paint the backdrop when boardName is omitted (existing call sites/tests)', () => {
      const { container } = render(
        createElement(LayeredClimbImage, { overlayUri: null, backgroundPaths: ['/bundled/kilter.webp'] }),
      );

      expect(container.querySelector('[data-testid="layered-climb-image-moonboard-backdrop"]')).toBeNull();
    });

    it('sits behind (renders before) the board background image layers', () => {
      const { container } = render(
        createElement(LayeredClimbImage, {
          overlayUri: null,
          backgroundPaths: ['/bundled/moonboard-bg.webp'],
          boardName: 'moonboard',
        }),
      );

      const backdrop = container.querySelector('[data-testid="layered-climb-image-moonboard-backdrop"]');
      const backgroundImage = container.querySelector('img[src="file:///bundled/moonboard-bg.webp"]');
      expect(backdrop).toBeTruthy();
      expect(backgroundImage).toBeTruthy();
      // compareDocumentPosition returns a bitmask, not a single enum value (it can
      // combine e.g. FOLLOWING with DISCONNECTED/IMPLEMENTATION_SPECIFIC bits), so
      // the correct check is masking for the FOLLOWING bit rather than an equality
      // check against a specific combined value. FOLLOWING set means `backgroundImage`
      // comes after `backdrop` in the tree, i.e. paints on top of it.
      // eslint-disable-next-line no-bitwise
      expect(
        (backdrop?.compareDocumentPosition(backgroundImage as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });
});
