// @vitest-environment jsdom
// The commit row's job is to never over-promise: the filled button says "Put on
// the wall" only where a wall can actually be reached, and it disappears rather
// than sitting there disabled when there is nothing to commit.
//
// The busy-wall confirm is the same row wearing different words. What the tests
// below pin is that it stays the SAME TWO CONTROLS in the same two positions —
// the filled button is still the commit, the text button is still the exit — so
// a climber whose thumb is already moving toward "Put on the wall" cannot land
// on a new action that appeared under it.
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
  // Forwards the live region: it lives on a plain View that outlives the
  // question, which is what makes arming the confirm a content change Android
  // will actually announce.
  View: ({ children, accessibilityLiveRegion, pointerEvents }: ViewMockProps & AnimatedViewMockProps) =>
    createElement(
      'div',
      { 'data-live-region': accessibilityLiveRegion, 'data-pointer-events': pointerEvents },
      children,
    ),
  Pressable: ({ children, onPress, accessibilityLabel, style }: PressMockProps) =>
    createElement(
      'button',
      { onClick: onPress, 'data-label': accessibilityLabel, 'data-style': JSON.stringify(resolveStyle(style) ?? null) },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: ViewMockProps) => createElement('div', { 'data-animated': 'true' }, children),
  },
  FadeIn: { duration: (ms: number) => ({ fadeIn: ms }) },
  useReducedMotion: () => false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Renders the interpolation so the confirm's "Someone just lit {{name}}"
    // can be asserted to actually carry the wall climb's name.
    t: (key: string, params?: Record<string, string>) => (params?.name != null ? `${key}:${params.name}` : key),
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  drawerActionBarStyles: { spacer: { flex: 1 }, actionButtonPressed: { opacity: 0.6 } },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    brandColors: { tint: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#FFFFFF', live: '#FFB020' },
    systemColors: { label: '#111111', elevatedSurface: '#FFFFFF' },
    m3SurfaceContainers: { high: '#EEE8F6' },
    materialElevation: { level2: { elevation: 2 } },
    radii: { button: 10 },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 5: 20 },
  borderRadius: { md: 8 },
  shadows: { sm: { shadowRadius: 2 } },
  androidRipple: (color: string) => ({ color, borderless: false }),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string, alpha: number) => `${color}/${alpha}` }));
vi.mock('../../../theme/variants/select-by-variant', () => ({
  selectByVariant: (variant: string, byVariant: Record<string, unknown>) => byVariant[variant],
}));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));

import { PlayDrawerCommitBar } from '../PlayDrawerCommitBar';

type AnimatedViewMockProps = { accessibilityLiveRegion?: string; pointerEvents?: string };

const baseProps = {
  showBackToLive: true,
  showPutOnWall: true,
  showConfirm: false,
  wallClimbName: null,
  commitLabel: 'putOnWall' as const,
  onBackToLive: vi.fn(),
  onCommit: vi.fn(),
};

/** What the confirm swap hands the row: both browse flags off, the pair on. */
const confirmProps = {
  ...baseProps,
  showBackToLive: false,
  showPutOnWall: false,
  showConfirm: true,
  wallClimbName: 'Their Project',
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

describe('PlayDrawerCommitBar — the busy-wall confirm', () => {
  it('swaps the same two controls in place, keeping the commit trailing', () => {
    // Position is the whole contract: a thumb already travelling toward "Put on
    // the wall" must not land on "Keep theirs" because the pair reordered.
    const { container } = render(createElement(PlayDrawerCommitBar, confirmProps));

    expect(buttonLabels(container)).toEqual([
      'playView.wallState.commitOverride.cancel',
      'playView.wallState.commitOverride.confirm',
    ]);
  });

  it('names the climb the wall is showing in the question', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, confirmProps));

    expect(container.textContent).toContain('playView.wallState.commitOverride.body:Their Project');
  });

  it('floats the question untouchable, with a polite live region for TalkBack', () => {
    // The bubble is the one piece of the confirm that isn't a control: it must
    // not eat a tap meant for the buttons underneath, and — since it can't be
    // reached by touch — the live region is how Android hears it at all.
    const { container } = render(createElement(PlayDrawerCommitBar, confirmProps));
    const region = container.querySelector('[data-live-region="polite"]') as HTMLElement;

    expect(region).toBeTruthy();
    expect(region.getAttribute('data-pointer-events')).toBe('none');
    expect(region.querySelector('[data-icon="warning"]')).toBeTruthy();
  });

  it('routes the second tap to the same commit handler', () => {
    // The first tap is what armed this, so "Put mine up" is not a new action —
    // it is the commit going through. A separate handler here would be a second
    // path to the wall that the arming ladder does not gate.
    const onCommit = vi.fn();
    const onBackToLive = vi.fn();
    const { container } = render(createElement(PlayDrawerCommitBar, { ...confirmProps, onCommit, onBackToLive }));

    (container.querySelector('[data-label="playView.wallState.commitOverride.confirm"]') as HTMLButtonElement).click();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onBackToLive).not.toHaveBeenCalled();
  });

  it('routes Keep theirs to the exit — leaving their climb up IS going back to live', () => {
    const onCommit = vi.fn();
    const onBackToLive = vi.fn();
    const { container } = render(createElement(PlayDrawerCommitBar, { ...confirmProps, onCommit, onBackToLive }));

    (container.querySelector('[data-label="playView.wallState.commitOverride.cancel"]') as HTMLButtonElement).click();

    expect(onBackToLive).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows no bubble while browsing — but keeps the live region waiting for it', () => {
    // The region has to pre-exist the question: Android announces a CHANGE inside
    // a live region, and a region that arrives already carrying its sentence is
    // not a change. So the empty region stays mounted, and only the bubble comes
    // and goes.
    const { container } = render(createElement(PlayDrawerCommitBar, baseProps));
    const region = container.querySelector('[data-live-region="polite"]') as HTMLElement;

    expect(region).toBeTruthy();
    expect(region.textContent).toBe('');
    expect(container.querySelector('[data-icon="warning"]')).toBeNull();
  });
});
