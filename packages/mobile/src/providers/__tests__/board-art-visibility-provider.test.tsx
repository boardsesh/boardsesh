// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const segments = vi.hoisted(() => ({ value: ['(tabs)', 'home'] as readonly string[] }));
vi.mock('expo-router', () => ({ useSegments: () => segments.value }));

const deviceLayout = vi.hoisted(() => ({ isPad: true }));
vi.mock('../../hooks/use-device-layout', () => ({ useDeviceLayout: () => ({ isPad: deviceLayout.isPad }) }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
}));

const appVisibility = vi.hoisted(() => ({ backgrounded: false }));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => appVisibility.backgrounded }));

import { BoardArtVisibilityProvider, type BoardArtTab } from '../board-art-visibility-provider';
import { useBoardArtVisible } from '../../components/board-art-visibility-context';
import { LayeredClimbImage } from '../../components/LayeredClimbImage';

function VisibleProbe() {
  return createElement('span', { 'data-visible': String(useBoardArtVisible()) });
}

function renderWithin(tab: BoardArtTab) {
  return render(createElement(BoardArtVisibilityProvider, { tab, children: createElement(VisibleProbe) }));
}

function readVisible(container: HTMLElement): string | null {
  return container.querySelector('span')?.getAttribute('data-visible') ?? null;
}

describe('BoardArtVisibilityProvider', () => {
  beforeEach(() => {
    deviceLayout.isPad = true;
    segments.value = ['(tabs)', 'home'];
    appVisibility.backgrounded = false;
  });

  it('reports visible on the focused iPad tab', () => {
    segments.value = ['(tabs)', 'climbs'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('true');
  });

  it('reports hidden on an inactive iPad tab', () => {
    segments.value = ['(tabs)', 'home'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('false');
  });

  it('stays visible for a pushed sub-route of the focused tab', () => {
    // A sub-route keeps the tab active (segment 1 is still 'climbs').
    segments.value = ['(tabs)', 'climbs', 'abc-uuid'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('true');
  });

  it('hides iPad tab art while the player route is focused', () => {
    segments.value = ['play'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('false');
  });

  it('is always visible on a non-iPad device regardless of the focused tab', () => {
    deviceLayout.isPad = false;
    segments.value = ['(tabs)', 'home'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('true');
  });

  it('keeps phone tab board art visible while the player is up', () => {
    deviceLayout.isPad = false;
    segments.value = ['play'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('true');
  });

  it('preserves phone image instances through repeated player opens and closes', () => {
    deviceLayout.isPad = false;
    segments.value = ['(tabs)', 'climbs'];
    const renderThumbnail = () =>
      createElement(BoardArtVisibilityProvider, {
        tab: 'climbs',
        children: createElement(LayeredClimbImage, {
          overlayUri: 'file:///overlay.png',
          backgroundPaths: ['/bundled/kilter.webp'],
        }),
      });
    const { container, rerender } = render(renderThumbnail());
    const backgroundImage = container.querySelector('img[src="file:///bundled/kilter.webp"]');
    const overlayImage = container.querySelector('img[src="file:///overlay.png"]');
    expect(backgroundImage).not.toBeNull();
    expect(overlayImage).not.toBeNull();

    for (let cycle = 0; cycle < 3; cycle++) {
      for (const nextSegments of [['play'], ['(tabs)', 'climbs']]) {
        segments.value = nextSegments;
        rerender(renderThumbnail());
        expect(container.querySelectorAll('img')).toHaveLength(2);
        expect(container.querySelector('img[src="file:///bundled/kilter.webp"]')).toBe(backgroundImage);
        expect(container.querySelector('img[src="file:///overlay.png"]')).toBe(overlayImage);
      }
    }

    // Keeping art through navigation must not disable app-background cleanup.
    segments.value = ['play'];
    appVisibility.backgrounded = true;
    rerender(renderThumbnail());
    expect(container.querySelector('img')).toBeNull();

    appVisibility.backgrounded = false;
    rerender(renderThumbnail());
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  // These drawers can leave the underlying list visible too.
  it('stays visible on iPhone under the user drawer', () => {
    deviceLayout.isPad = false;
    segments.value = ['user-drawer'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('true');
  });

  it('stays visible on iPhone under the create drawer', () => {
    deviceLayout.isPad = false;
    segments.value = ['(tabs)', 'climbs', 'create'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('true');
  });

  it('still blanks an inactive iPad tab under the user drawer', () => {
    // iPad behaviour is unchanged: a root modal leaves no tab active, so every tab
    // blanks via the iPad branch.
    segments.value = ['user-drawer'];
    const { container } = renderWithin('climbs');
    expect(readVisible(container)).toBe('false');
  });
});
