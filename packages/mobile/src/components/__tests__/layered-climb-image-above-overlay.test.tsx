// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Style = Record<string, unknown> | false | null | undefined | Style[];
function flatten(style: Style): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({
    children,
    testID,
    style,
    pointerEvents,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: Style;
    pointerEvents?: string;
  }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-opacity': flatten(style).opacity as number | undefined,
        'data-pointer-events': pointerEvents,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-image', () => ({
  Image: ({ source, onLoad }: { source: { uri: string }; onLoad?: () => void }) =>
    createElement('img', { src: source.uri, onLoad }),
}));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

import { LayeredClimbImage } from '../LayeredClimbImage';
import { BoardArtVisibilityContext } from '../board-art-visibility-context';

const SLOT = '[data-testid="layered-climb-image-above-overlay"]';
const labels = createElement('span', { 'data-testid': 'grid-labels' });

describe('LayeredClimbImage aboveOverlay', () => {
  it('draws the slot above the holds overlay, out of the way of touches', () => {
    const { container } = render(
      <LayeredClimbImage
        overlayUri="file:///overlay.png"
        backgroundPaths={['/bundled/moonboard2024/woodenholds.webp']}
        aboveOverlay={labels}
      />,
    );
    const stack = container.firstElementChild!;
    const children = [...stack.children];
    const slot = container.querySelector(SLOT)!;
    const overlay = container.querySelector('img[src="file:///overlay.png"]')!;
    expect(children.indexOf(slot)).toBeGreaterThan(children.indexOf(overlay));
    expect(slot.getAttribute('data-pointer-events')).toBe('none');
    expect(slot.querySelector('[data-testid="grid-labels"]')).toBeTruthy();
  });

  it('adds nothing when no caller fills the slot', () => {
    const { container } = render(
      <LayeredClimbImage overlayUri="file:///overlay.png" backgroundPaths={['/bundled/kilter.webp']} />,
    );
    expect(container.querySelector(SLOT)).toBeNull();
  });

  // The labels must not arrive on a board the reveal is still holding back: they
  // would float on an empty box until the holds land.
  it('is held back with the rest of the stack while the reveal waits, then shown', () => {
    const { container } = render(
      <LayeredClimbImage
        overlayUri="file:///a.png"
        overlayLoadKey="a"
        backgroundPaths={['/bundled/moonboard2024/woodenholds.webp']}
        revealWithOverlay="first-paint"
        aboveOverlay={labels}
      />,
    );
    expect(container.querySelector(SLOT)!.getAttribute('data-opacity')).toBe('0');

    act(() => {
      fireEvent.load(container.querySelector('img[src="file:///a.png"]')!);
    });
    expect(container.querySelector(SLOT)!.getAttribute('data-opacity')).toBeNull();
  });

  it('is dropped with the rest of the board art while the surface is hidden', () => {
    const { container } = render(
      <BoardArtVisibilityContext.Provider value={false}>
        <LayeredClimbImage
          overlayUri="file:///overlay.png"
          backgroundPaths={['/bundled/moonboard2024/woodenholds.webp']}
          aboveOverlay={labels}
        />
      </BoardArtVisibilityContext.Provider>,
    );
    expect(container.querySelector(SLOT)).toBeNull();
    expect(container.querySelector('[data-testid="grid-labels"]')).toBeNull();
  });
});
