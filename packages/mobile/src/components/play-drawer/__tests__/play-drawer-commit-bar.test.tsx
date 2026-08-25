// @vitest-environment jsdom
// The commit row's job is to never over-promise: the filled button says "Put on
// the wall" only where a wall can actually be reached, and it disappears rather
// than sitting there disabled when there is nothing to commit.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; style?: unknown };
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: unknown;
};
// Pressable takes a style FUNCTION here (pressed feedback), so resolve it the
// way RN would to keep the serialised style assertable.
const resolveStyle = (style: unknown) => (typeof style === 'function' ? style({ pressed: false }) : style);

vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel, style }: PressMockProps) =>
    createElement(
      'button',
      { onClick: onPress, 'data-label': accessibilityLabel, 'data-style': JSON.stringify(resolveStyle(style) ?? null) },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: ViewMockProps) => createElement('div', null, children) },
  FadeIn: { duration: (ms: number) => ({ fadeIn: ms }) },
  useReducedMotion: () => false,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  drawerActionBarStyles: { spacer: { flex: 1 }, actionButtonPressed: { opacity: 0.6 } },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { tint: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#FFFFFF' },
    radii: { button: 10 },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 5: 20 },
  androidRipple: (color: string) => ({ color, borderless: false }),
}));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));

import { PlayDrawerCommitBar } from '../PlayDrawerCommitBar';

const baseProps = {
  showBackToLive: true,
  showPutOnWall: true,
  commitLabel: 'putOnWall' as const,
  onBackToLive: vi.fn(),
  onCommit: vi.fn(),
};

const buttonLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((node) => node.getAttribute('data-label') ?? '');

describe('PlayDrawerCommitBar', () => {
  it('offers the exit and the commit, in that order', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, baseProps));

    expect(buttonLabels(container)).toEqual(['playView.wallState.backToLive', 'playView.wallState.putOnWall']);
  });

  it('falls back to "Set active" where no wall is reachable', () => {
    // A plain logbook / settings preview with no BLE link and no session: the
    // button still commits, but promising to light a board that isn't there
    // would be a lie the climber only discovers by tapping.
    const { container } = render(createElement(PlayDrawerCommitBar, { ...baseProps, commitLabel: 'setActive' }));

    expect(buttonLabels(container)).toContain('playView.setActive');
    expect(buttonLabels(container)).not.toContain('playView.wallState.putOnWall');
  });

  it('hides the commit rather than rendering it disabled-dead', () => {
    // Looking at the climb that is already lit: there is nothing to commit, and
    // a greyed-out button invites a tap that can only do nothing.
    const { container } = render(createElement(PlayDrawerCommitBar, { ...baseProps, showPutOnWall: false }));

    expect(buttonLabels(container)).toEqual(['playView.wallState.backToLive']);
  });

  it('keeps Back to live as the only control when the commit is hidden', () => {
    const onBackToLive = vi.fn();
    const { container } = render(
      createElement(PlayDrawerCommitBar, { ...baseProps, showPutOnWall: false, onBackToLive }),
    );

    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onBackToLive).toHaveBeenCalledTimes(1);
  });

  it('runs the commit handler, not the exit, from the filled button', () => {
    const onCommit = vi.fn();
    const onBackToLive = vi.fn();
    const { container } = render(createElement(PlayDrawerCommitBar, { ...baseProps, onCommit, onBackToLive }));

    const commit = container.querySelector('[data-label="playView.wallState.putOnWall"]') as HTMLButtonElement;
    commit.click();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onBackToLive).not.toHaveBeenCalled();
  });

  it('paints the commit as a brand fill with its own ink, and the exit as bare tint', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, baseProps));
    const commit = container.querySelector('[data-label="playView.wallState.putOnWall"]') as HTMLElement;

    expect(commit.getAttribute('data-style')).toContain('"backgroundColor":"#6D28D9"');
    // White on the violet fill — never the tint colour, which would vanish.
    expect(commit.querySelector('span[data-color="#FFFFFF"]')).toBeTruthy();
    const back = container.querySelector('[data-label="playView.wallState.backToLive"]') as HTMLElement;
    expect(back.getAttribute('data-style')).not.toContain('backgroundColor');
    expect(back.querySelector('span[data-color="#6D28D9"]')).toBeTruthy();
  });
});
