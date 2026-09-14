// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface. View forwards accessibilityViewIsModal onto a data
// attribute so the scrim's modal-focus trap (keeps the blocked queue/tick/BLE
// controls out of the a11y tree) is inspectable.
type ViewMockProps = { children?: ReactNode; accessibilityViewIsModal?: boolean };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityViewIsModal }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-modal': accessibilityViewIsModal == null ? undefined : String(accessibilityViewIsModal),
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// t echoes the key, appending the interpolated board so the title/subtitle copy
// is asserted to actually thread boardLabel through.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { board?: string }) => (options?.board ? `${key}:${options.board}` : key),
  }),
}));

// Icon → expose name so the lock glyph is present. Paths are relative to THIS
// test file (one level under the source in __tests__), so they carry an extra
// `../`.
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
// Real <button> so onPress is exercisable; the real Button drags in
// react-native-paper + haptics, which jsdom can't host.
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title?: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
// The glass surface picks its rendering path from Platform + capability hooks,
// none of which this harness mounts. Its own behaviour is covered by
// GlassSurface's tests; here it is just the box the callout draws in.
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-glass': 'true' }, children),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../theme/tokens', () => ({
  overlays: { scrim: '#0008', onScrim: '#FFFFFF' },
  borderRadius: { lg: 16 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 },
}));

import { SwitchBoardOverlay } from '../SwitchBoardOverlay';

describe('SwitchBoardOverlay', () => {
  it('interpolates boardLabel into the mismatch title and subtitle copy', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Kilter', onSwitchBoard: vi.fn() }));

    expect(container.textContent).toContain('boardMismatch.title:Kilter');
    expect(container.textContent).toContain('boardMismatch.subtitle:Kilter');
  });

  it('traps a11y focus on the scrim via accessibilityViewIsModal', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Tension', onSwitchBoard: vi.fn() }));

    expect(container.querySelector('[data-modal="true"]')).toBeTruthy();
  });

  it('switches boards once when the CTA is pressed', () => {
    const onSwitchBoard = vi.fn();
    const { container } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Kilter', onSwitchBoard }));
    const cta = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'boardMismatch.cta',
    ) as HTMLButtonElement;

    expect(cta).toBeTruthy();
    cta.click();

    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
  });
});

// The same fact — this climb is on another board — told as an invitation when
// that board is across the room rather than across the country.
describe('SwitchBoardOverlay, move variant', () => {
  const moveProps = { boardLabel: 'Tension 2', variant: 'move' as const };

  it('invites instead of refusing', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { ...moveProps, onSwitchBoard: vi.fn() }));

    expect(container.textContent).toContain('mobile.boardPresence.moveToWall.title:Tension 2');
    expect(container.textContent).toContain('mobile.boardPresence.moveToWall.body');
    expect(container.textContent).not.toContain('boardMismatch.title');
  });

  // The scrim's a11y trap is what blocks the queue, tick and favourite controls.
  // A board the climber can walk to must not block any of them.
  // QA: "should be like a glass surface over the normal controls". A flat scrim
  // let the controls bleed through it crisply; glass recesses them instead.
  it('draws on a glass surface, not a flat scrim', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { ...moveProps, onSwitchBoard: vi.fn() }));

    expect(container.querySelector('[data-glass]')).toBeTruthy();
  });

  it('does not trap a11y focus or show the lock', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { ...moveProps, onSwitchBoard: vi.fn() }));

    expect(container.querySelector('[data-modal="true"]')).toBeNull();
    expect(container.querySelector('[data-icon="lock"]')).toBeNull();
  });

  it('offers going there and skipping it as separate actions', () => {
    const onSwitchBoard = vi.fn();
    const onSkip = vi.fn();
    const { container } = render(createElement(SwitchBoardOverlay, { ...moveProps, onSwitchBoard, onSkip }));
    const buttons = [...container.querySelectorAll('button')];

    const move = buttons.find(
      (button) => button.textContent === 'mobile.boardPresence.moveToWall.cta:Tension 2',
    ) as HTMLButtonElement;
    const skip = buttons.find(
      (button) => button.textContent === 'mobile.boardPresence.moveToWall.skip',
    ) as HTMLButtonElement;
    expect(move).toBeTruthy();
    expect(skip).toBeTruthy();

    move.click();
    skip.click();

    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  // Nothing to skip to when the caller has no queue to advance — the invitation
  // still stands, it just has one way out.
  it('omits skip when no skip handler is given', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { ...moveProps, onSwitchBoard: vi.fn() }));

    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'mobile.boardPresence.moveToWall.cta:Tension 2',
    ]);
  });
});
