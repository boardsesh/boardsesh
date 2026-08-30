// @vitest-environment jsdom
// The play drawer swipes TWO of these past each other: the current climb's
// header (which may carry the wall-state pill in its leading slot) and the peek
// header sliding in behind it. If the two disagree about their geometry, the
// climb name and its attribute glyphs step as they cross — which is exactly what
// `minRowHeight` and the peek's reserved leading slot exist to prevent. So the
// assertions here are about the row keeping ONE height and ONE flank model,
// whichever branch it takes.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; style?: unknown; onLayout?: unknown };
const styleAttr = (style: unknown) => JSON.stringify(style ?? null);

vi.mock('react-native', () => ({
  View: ({ children, style }: ViewMockProps) => createElement('div', { 'data-style': styleAttr(style) }, children),
  StyleSheet: { create: (sheet: Record<string, unknown>) => sheet },
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16, 12: 48 } }));

import { DrawerHeader } from '../DrawerHeader';

const ROW_HEIGHT = 44;

/** Flattened styles of every view, innermost detail included. */
const styles = (container: HTMLElement) =>
  [...container.querySelectorAll('div[data-style]')].map((node) => node.getAttribute('data-style') ?? '');

const renderHeader = (leading?: ReactNode) =>
  render(
    createElement(DrawerHeader, {
      center: createElement('span', null, 'Climb name'),
      trailing: createElement('span', null, 'V5'),
      leading,
      minRowHeight: ROW_HEIGHT,
    }),
  );

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

  it('mirrors the flanks so the centred name cannot drift toward the grade', () => {
    const { container } = renderHeader(createElement('span', null, 'Live'));
    // Both flanks are rendered at the same measured width (the trailing floor
    // until onLayout reports, which jsdom never does).
    const flanks = styles(container).filter((style) => style.includes('"width":48'));

    expect(flanks).toHaveLength(2);
  });
});
