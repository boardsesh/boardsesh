// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
// The browse latch's two controls in the second action row.
//
// `PutOnWallButton` never over-promises: it says "Put on the wall" only where a
// wall can actually be reached, and "Set active" everywhere else.
//
// `PlayDrawerCommitBar` is now only the busy-wall question. What the tests below
// pin is that the commit stays CENTRED — "Put mine up" lands where Put on the
// wall was, in the middle of the row — so a climber whose thumb is already
// moving toward the button that armed the question cannot land on a new action
// that appeared under it. It names who put the lit climb up when the crew's
// current climb says so (and it isn't you), and speaks the question once on
// mount, since the bubble that carries it can't be touched.
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const announceForAccessibility = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
// The crew's current climb records who picked it; the viewer is "me".
type HeadItem = { climb: { uuid: string }; addedByUser?: { id: string; username: string } };
const queueData = vi.hoisted(() => ({
  currentClimbQueueItem: null as HeadItem | null,
  currentChangedBy: null as string | null,
}));
const roster = vi.hoisted(() => ({ sessionUsers: [] as Array<{ id: string; username: string }> }));
const viewer = vi.hoisted(() => ({ participantId: 'me' as string | null }));

type ViewMockProps = {
  children?: ReactNode;
  style?: unknown;
  accessibilityLiveRegion?: string;
  pointerEvents?: string;
};
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: unknown;
};
// Pressable takes a style FUNCTION here (pressed feedback), so resolve it the
// way RN would to keep the serialised style assertable.
const resolveStyle = (style: unknown) => (typeof style === 'function' ? style({ pressed: false }) : style);
const flattenStyle = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(10).filter(Boolean));

vi.mock('react-native', () => ({
  // Forwards the live region and the style: the region is how TalkBack hears a
  // renamed question, and the style is what keeps the row from collapsing.
  View: ({ children, accessibilityLiveRegion, pointerEvents, style }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-live-region': accessibilityLiveRegion,
        'data-pointer-events': pointerEvents,
        'data-style': style == null ? undefined : JSON.stringify(flattenStyle(style)),
      },
      children,
    ),
  Pressable: ({ children, onPress, accessibilityLabel, style }: PressMockProps) =>
    createElement(
      'button',
      { onClick: onPress, 'data-label': accessibilityLabel, 'data-style': JSON.stringify(resolveStyle(style) ?? null) },
      children,
    ),
  StyleSheet: {
    flatten: (style: unknown) => flattenStyle(style),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  AccessibilityInfo: { announceForAccessibility },
  Platform: platform,
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
    // Renders the interpolations (person first, then the climb) so the question
    // can be asserted to carry who lit the wall and what they lit.
    t: (key: string, params?: Record<string, string>) =>
      [key, params?.person, params?.name].filter((part) => part != null).join(':'),
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => queueData,
  useQueueSessionControls: () => viewer,
  useQueueLiveStats: () => roster,
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
  useOptionalTheme: () => null,
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
  opacity: { disabled: 0.5 },
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

import { PlayDrawerCommitBar, PutOnWallButton } from '../PlayDrawerCommitBar';

const WALL_CLIMB = 'climb-on-the-wall';

const questionProps = {
  wallClimbName: 'Their Project',
  wallClimbUuid: WALL_CLIMB,
  onKeepTheirs: vi.fn(),
  onConfirm: vi.fn(),
};

/** The crew's current climb: the lit one, put up by `username` unless overridden. */
const head = (username: string, overrides: Partial<HeadItem> = {}): HeadItem => {
  const item = { climb: { uuid: WALL_CLIMB }, addedByUser: { id: `user-${username}`, username }, ...overrides };
  queueData.currentChangedBy = item.addedByUser?.id ?? null;
  roster.sessionUsers = item.addedByUser ? [item.addedByUser] : [];
  return item;
};

const buttonLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((node) => node.getAttribute('data-label') ?? '');

const styleOf = (node: Element | null) =>
  JSON.parse(node?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  announceForAccessibility.mockClear();
  queueData.currentClimbQueueItem = null;
  queueData.currentChangedBy = null;
  roster.sessionUsers = [];
  viewer.participantId = 'me';
});

describe('PutOnWallButton', () => {
  it('says "Put on the wall" where a wall is reachable', () => {
    const { container } = render(createElement(PutOnWallButton, { commitLabel: 'putOnWall', onPress: vi.fn() }));

    expect(buttonLabels(container)).toEqual(['playView.wallState.putOnWall']);
  });

  it('falls back to "Set active" where no wall is reachable', () => {
    // A plain logbook / settings preview with no BLE link and no session: the
    // button still commits, but promising to light a board that isn't there
    // would be a lie the climber only discovers by tapping.
    const { container } = render(createElement(PutOnWallButton, { commitLabel: 'setActive', onPress: vi.fn() }));

    expect(buttonLabels(container)).toEqual(['playView.setActive']);
  });

  it('runs its handler on a tap', () => {
    const onPress = vi.fn();
    const { container } = render(createElement(PutOnWallButton, { commitLabel: 'putOnWall', onPress }));

    (container.querySelector('button') as HTMLButtonElement).click();

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('paints a brand fill with its own ink', () => {
    const { container } = render(createElement(PutOnWallButton, { commitLabel: 'putOnWall', onPress: vi.fn() }));
    const button = container.querySelector('button') as HTMLElement;

    expect(button.getAttribute('data-style')).toContain('"backgroundColor":"#6D28D9"');
    // White on the violet fill — never the tint colour, which would vanish.
    expect(button.querySelector('span[data-color="#FFFFFF"]')).toBeTruthy();
  });
});

describe('PlayDrawerCommitBar — the busy-wall question', () => {
  it('offers Keep theirs then Put mine up, the commit where Put on the wall was', () => {
    // Position is the whole contract: a thumb already travelling toward "Put on
    // the wall" must land on the commit, never on "Keep theirs".
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));

    expect(buttonLabels(container)).toEqual([
      'playView.wallState.commitOverride.cancel',
      'playView.wallState.commitOverride.confirm',
    ]);
  });

  it('names the climb the wall is showing, and "someone" when nobody can be named', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));

    expect(container.textContent).toContain('playView.wallState.commitOverride.body:Their Project');
    expect(container.textContent).not.toContain('bodyNamed');
  });

  it('names who put the lit climb up, in the question and in Keep theirs', () => {
    queueData.currentClimbQueueItem = head('Sam');
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));

    expect(container.textContent).toContain('playView.wallState.commitOverride.bodyNamed:Sam:Their Project');
    expect(buttonLabels(container)).toEqual([
      'playView.wallState.commitOverride.cancelNamed:Sam',
      'playView.wallState.commitOverride.confirm',
    ]);
  });

  it('names Sam who moved Alex’s queued climb, never Alex who queued it', () => {
    queueData.currentClimbQueueItem = head('Alex');
    queueData.currentChangedBy = 'participant-sam';
    roster.sessionUsers.push({ id: 'participant-sam', username: 'Sam' });
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));
    expect(container.textContent).toContain('bodyNamed:Sam:Their Project');
    expect(container.textContent).not.toContain('bodyNamed:Alex');
  });

  it('keeps queue authorship unnamed when no mover is recorded', () => {
    queueData.currentClimbQueueItem = head('Alex');
    queueData.currentChangedBy = null;
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));
    expect(container.textContent).not.toContain('bodyNamed');
  });

  // Each of these would name the wrong person, or the climber themself, so the
  // question falls back to the unnamed wording.
  it.each([
    ['the viewer put it up', () => head('Me', { addedByUser: { id: 'me', username: 'Me' } })],
    ['the crew’s current climb is not the lit one', () => head('Sam', { climb: { uuid: 'climb-elsewhere' } })],
    ['nobody is recorded as having put it up', () => ({ climb: { uuid: WALL_CLIMB } })],
    ['there is no current climb', () => null],
  ] as Array<[string, () => HeadItem | null]>)('stays unnamed when %s', (_scenario, makeHead) => {
    queueData.currentClimbQueueItem = makeHead();
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));

    expect(container.textContent).toContain('playView.wallState.commitOverride.body:Their Project');
    expect(container.textContent).not.toContain('bodyNamed');
    expect(buttonLabels(container)).toEqual([
      'playView.wallState.commitOverride.cancel',
      'playView.wallState.commitOverride.confirm',
    ]);
  });

  // Signed out, or the profile still loading on a cold start: an unknown viewer
  // could be the picker, so it is never read as "somebody else".
  it('stays unnamed while the viewer is not known yet', () => {
    queueData.currentClimbQueueItem = head('Sam');
    viewer.participantId = null;
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));

    expect(container.textContent).not.toContain('bodyNamed');
    expect(buttonLabels(container)[0]).toBe('playView.wallState.commitOverride.cancel');
    viewer.participantId = 'me';
  });

  it('stays unnamed when the lit climb is unknown, even with a picker on the current climb', () => {
    queueData.currentClimbQueueItem = head('Sam');
    const { container } = render(createElement(PlayDrawerCommitBar, { ...questionProps, wallClimbUuid: null }));

    expect(container.textContent).not.toContain('bodyNamed');
    expect(buttonLabels(container)[0]).toBe('playView.wallState.commitOverride.cancel');
  });

  it('routes Put mine up to the confirm handler only', () => {
    // The first tap is what armed this, so "Put mine up" is not a new action —
    // it is the commit going through.
    const onConfirm = vi.fn();
    const onKeepTheirs = vi.fn();
    const { container } = render(createElement(PlayDrawerCommitBar, { ...questionProps, onConfirm, onKeepTheirs }));

    (container.querySelector('[data-label="playView.wallState.commitOverride.confirm"]') as HTMLButtonElement).click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onKeepTheirs).not.toHaveBeenCalled();
  });

  it('routes Keep theirs to its own handler, sending nothing', () => {
    const onConfirm = vi.fn();
    const onKeepTheirs = vi.fn();
    const { container } = render(createElement(PlayDrawerCommitBar, { ...questionProps, onConfirm, onKeepTheirs }));

    (container.querySelector('[data-label="playView.wallState.commitOverride.cancel"]') as HTMLButtonElement).click();

    expect(onKeepTheirs).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('paints Put mine up as the brand fill and Keep theirs as bare tint', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));
    const confirm = container.querySelector('[data-label="playView.wallState.commitOverride.confirm"]') as HTMLElement;
    const keep = container.querySelector('[data-label="playView.wallState.commitOverride.cancel"]') as HTMLElement;

    expect(confirm.getAttribute('data-style')).toContain('"backgroundColor":"#6D28D9"');
    expect(confirm.querySelector('span[data-color="#FFFFFF"]')).toBeTruthy();
    expect(keep.getAttribute('data-style')).not.toContain('backgroundColor');
    expect(keep.querySelector('span[data-color="#6D28D9"]')).toBeTruthy();
  });

  it('floats the question untouchable, with a polite live region for TalkBack', () => {
    // The bubble is the one piece of the question that isn't a control: it must
    // not eat a tap meant for the buttons underneath.
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));
    const region = container.querySelector('[data-live-region="polite"]') as HTMLElement;

    expect(region).toBeTruthy();
    expect(region.getAttribute('data-pointer-events')).toBe('none');
    expect(region.querySelector('[data-icon="warning"]')).toBeTruthy();
    expect(region.textContent).toContain('playView.wallState.commitOverride.body:Their Project');
  });

  it('speaks the question once when it mounts, on every platform', () => {
    // The row mounts the moment the question arms. A live region that mounts
    // already holding its text is not a content change, so the bar says it
    // itself; a re-render with the same question must not say it again.
    queueData.currentClimbQueueItem = head('Sam');
    const { rerender } = render(createElement(PlayDrawerCommitBar, questionProps));

    expect(announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(announceForAccessibility).toHaveBeenCalledWith(
      'playView.wallState.commitOverride.bodyNamed:Sam:Their Project',
    );

    rerender(createElement(PlayDrawerCommitBar, { ...questionProps, onConfirm: vi.fn() }));
    expect(announceForAccessibility).toHaveBeenCalledTimes(1);
  });

  // The name resolving (or someone lighting yet another climb) changes the
  // question while it's up. iOS hears it again from the bar; Android's polite
  // live region reads the change itself, so the bar must not say it twice there.
  it.each([
    ['ios', 2],
    ['android', 1],
  ] as const)('on %s, a changed question is spoken %i time(s) in all', (os, times) => {
    platform.OS = os;
    queueData.currentClimbQueueItem = null;
    const { rerender } = render(createElement(PlayDrawerCommitBar, questionProps));
    queueData.currentClimbQueueItem = head('Sam');
    // A fresh handler forces the memo'd bar to render again and re-read the name.
    rerender(createElement(PlayDrawerCommitBar, { ...questionProps, onConfirm: vi.fn() }));

    expect(announceForAccessibility).toHaveBeenCalledTimes(times);
    platform.OS = 'ios';
  });

  // Regression: `flex: 1` on the controls set flexBasis 0 in RN, which collapsed
  // this content-sized row to 0pt and spilled the 44pt buttons over the bar above.
  it('holds the row at the control height instead of collapsing it', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));
    const keep = container.querySelector('[data-label="playView.wallState.commitOverride.cancel"]');
    const controls = keep?.parentElement?.parentElement ?? null;
    const row = controls?.parentElement ?? null;

    expect(styleOf(row)).toMatchObject({ minHeight: 44 });
    expect(styleOf(controls)).toMatchObject({ flexGrow: 1, flexDirection: 'row' });
    expect(styleOf(controls)).not.toHaveProperty('flex');
  });

  // Put mine up sits in the middle, where Put on the wall was: two equal
  // halves either side of it, Keep in the left one and the right one empty.
  it('centres Put mine up between two equal halves, Keep in the left', () => {
    const { container } = render(createElement(PlayDrawerCommitBar, questionProps));
    const keep = container.querySelector('[data-label="playView.wallState.commitOverride.cancel"]');
    const confirm = container.querySelector('[data-label="playView.wallState.commitOverride.confirm"]');
    const controls = keep?.parentElement?.parentElement ?? null;
    const [leftHalf, middle, rightHalf, ...rest] = [...(controls?.children ?? [])];

    expect(rest).toHaveLength(0);
    expect(leftHalf.contains(keep)).toBe(true);
    expect(middle).toBe(confirm);
    expect(rightHalf.childElementCount).toBe(0);
    expect(styleOf(leftHalf)).toMatchObject({ flex: 1 });
    expect(styleOf(rightHalf)).toMatchObject({ flex: 1 });
    expect(styleOf(rightHalf)).toEqual(styleOf(leftHalf));
  });
});
