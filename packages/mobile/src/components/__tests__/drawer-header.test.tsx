// @vitest-environment jsdom
// The play drawer swipes TWO of these past each other: the current climb's
// header (which may carry the wall-state pill in its leading slot) and the peek
// header sliding in behind it. If the two disagree about their geometry, the
// climb name and its attribute glyphs step as they cross — which is exactly what
// `minRowHeight` and the peek's reserved leading slot exist to prevent. So the
// assertions here are about the row keeping ONE height and ONE flank model,
// whichever branch it takes.
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type LayoutEvent = { nativeEvent: { layout: { width: number } } };
type ViewMockProps = { children?: ReactNode; style?: unknown; onLayout?: (event: LayoutEvent) => void };
const styleAttr = (style: unknown) => JSON.stringify(style ?? null);

// jsdom never lays anything out, so the measured flanks would sit at 0 forever
// and every assertion would really be reading the trailing floor. Capture the
// handlers instead and feed them widths by hand — that is the only way to reach
// the re-balancing this chassis exists for. Filled in render order, so [0] is
// the leading measure view and [1] the trailing one.
const layoutHandlers: Array<(event: LayoutEvent) => void> = [];

vi.mock('react-native', () => ({
  View: ({ children, style, onLayout }: ViewMockProps) => {
    if (onLayout) layoutHandlers.push(onLayout);
    return createElement('div', { 'data-style': styleAttr(style) }, children);
  },
  StyleSheet: { create: (sheet: Record<string, unknown>) => sheet },
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16, 12: 48 } }));

import { DrawerHeader } from '../DrawerHeader';

const ROW_HEIGHT = 44;

/** Flattened styles of every view, innermost detail included. */
const styles = (container: HTMLElement) =>
  [...container.querySelectorAll('div[data-style]')].map((node) => node.getAttribute('data-style') ?? '');

/** Clears the handler list first, so `layoutHandlers` always belongs to THIS render. */
const renderHeader = (leading?: ReactNode) => {
  layoutHandlers.length = 0;
  return render(
    createElement(DrawerHeader, {
      center: createElement('span', null, 'Climb name'),
      trailing: createElement('span', null, 'V5'),
      leading,
      minRowHeight: ROW_HEIGHT,
    }),
  );
};

/** Report a measured width for the leading flank, the way a real layout pass would. */
const measureLeading = (width: number) => {
  // Fail loudly rather than silently measuring the wrong slot if the chassis
  // ever renders its flanks in the other order.
  expect(layoutHandlers).toHaveLength(2);
  act(() => layoutHandlers[0]({ nativeEvent: { layout: { width } } }));
};

/** The row is the one view carrying both the row direction and the height floor. */
const rowStyle = (container: HTMLElement) =>
  styles(container).find((style) => style.includes('"flexDirection":"row"')) ?? '';

describe('DrawerHeader', () => {
  it('holds the same row height with and without a leading element', () => {
    const withPill = renderHeader(createElement('span', null, 'Live'));
    const withoutPill = renderHeader();

    expect(rowStyle(withPill.container)).toContain(`"minHeight":${ROW_HEIGHT}`);
    expect(rowStyle(withoutPill.container)).toContain(`"minHeight":${ROW_HEIGHT}`);
  });

  // Without the floor the row is only as tall as its tallest child, so a 44pt
  // pill beside a ~40pt centre column grew the whole header — and, inside the
  // drawer's fixed-height first screen, shrank the board art below it.
  it('leaves the row unconstrained when no floor is asked for', () => {
    const { container } = render(
      createElement(DrawerHeader, {
        center: createElement('span', null, 'Climb name'),
        trailing: createElement('span', null, 'V5'),
      }),
    );

    expect(rowStyle(container)).not.toContain('minHeight');
  });

  // The contract this chassis exists for: both flanks take the WIDER of the two
  // so the centred name cannot drift toward the narrower (grade) side. Driving a
  // real measurement is the only way to reach it — asserting the un-measured
  // state would just be reading the trailing floor back.
  it('widens both flanks to a leading element wider than the floor', () => {
    const { container } = renderHeader(createElement('span', null, 'Live'));
    measureLeading(62);

    expect(styles(container).filter((style) => style.includes('"width":62'))).toHaveLength(2);
  });

  it('keeps the floor when the leading element is narrower than it', () => {
    const { container } = renderHeader(createElement('span', null, 'Live'));
    measureLeading(20);

    expect(styles(container).filter((style) => style.includes('"width":48'))).toHaveLength(2);
  });

  // Rounded up, never down. A flank that landed on a fraction would let the swipe
  // peek and the current header disagree by a subpixel — the exact drift the
  // reserved slot is there to prevent.
  it('rounds a fractional measurement up', () => {
    const { container } = renderHeader(createElement('span', null, 'Live'));
    measureLeading(61.4);

    expect(styles(container).filter((style) => style.includes('"width":62'))).toHaveLength(2);
  });
});
