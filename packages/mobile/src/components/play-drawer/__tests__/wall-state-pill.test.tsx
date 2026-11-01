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
// The header pill is the one place the drawer STATES what the wall is doing, so
// the assertions below are about truthfulness, not pixels: which state prints
// which words, that the words it can't print (there's no room beside the climb
// name) survive in the accessibility label, and that the tap it invites is
// actually reachable. Narration is the host's job now — see
// use-wall-state-announcer.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ComponentProps, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; style?: unknown };
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityElementsHidden?: boolean;
  android_ripple?: { color: string; borderless: boolean };
  style?: unknown | ((state: { pressed: boolean }) => unknown);
};
const styleAttr = (style: unknown) => JSON.stringify(style ?? null);

vi.mock('react-native', () => ({
  View: ({ children, style }: ViewMockProps) => createElement('div', { 'data-style': styleAttr(style) }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    accessibilityElementsHidden,
    android_ripple,
    style,
  }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-role': accessibilityRole ?? '',
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-a11y-hidden': accessibilityElementsHidden ? 'true' : '',
        'data-ripple': android_ripple ? JSON.stringify(android_ripple) : '',
        'data-style': styleAttr(typeof style === 'function' ? style({ pressed: false }) : style),
        'data-style-pressed': styleAttr(typeof style === 'function' ? style({ pressed: true }) : style),
      },
      children,
    ),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, style }: ViewMockProps) => createElement('div', { 'data-style': styleAttr(style) }, children),
  },
  FadeIn: { duration: (ms: number) => ({ fadeIn: ms }) },
  useReducedMotion: () => false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      key === 'mobile.boardPresence.drivenByA11y'
        ? `${opts?.name} is lighting the wall.`
        : opts?.name
          ? `${key}:${JSON.stringify({ name: opts.name })}`
          : key,
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name?: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color }),
}));
// Records what identity + status the pill hands the avatar. `userId` must stay
// null: a pressable avatar inside a pressable pill is a nested touchable.
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({
    userId,
    name,
    status,
    size,
  }: {
    userId?: string | null;
    name?: string | null;
    status?: string;
    size?: number;
  }) =>
    createElement('div', {
      'data-driver-avatar': 'true',
      'data-user-id': userId ?? '',
      'data-name': name ?? '',
      'data-status': status,
      'data-size': size == null ? undefined : String(size),
    }),
}));

const driverState = vi.hoisted(() => ({
  value: {
    driver: null as { userId: string | null; avatarUrl: string | null } | null,
    name: null as string | null,
    litAgo: null as string | null,
  },
}));
vi.mock('../use-wall-driver', () => ({ useWallDriver: () => driverState.value }));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { secondaryBackground: '#FFF', label: '#111', separator: '#CCC' },
    brandColors: { accent: '#FF8A3D', onAccent: '#16111F', live: '#B45309' },
    m3: { onSurface: '#111', tertiary: '#7A5230' },
    m3SurfaceContainers: { high: '#EEE' },
  }),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string, alpha: number) => `${color}@${alpha}` }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 3: 12 },
  borderRadius: { full: 9999 },
  androidRipple: (color: string, borderless: boolean) => ({ color, borderless }),
}));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../theme/layout', () => ({
  glassSize: { mini: 32, inline: 44 },
  WALL_LIVE_DOT_SIZE: 10,
  WALL_STATE_PILL_TOUCH_HEIGHT: 44,
}));

vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({
    title,
    onActivate,
    children,
  }: {
    title: string;
    onActivate?: () => void;
    children?: ReactNode;
  }) => createElement('span', { 'data-viewer-title': title, onContextMenu: onActivate }, children),
}));

import { WallStatePill } from '../WallStatePill';

type WallStatePillProps = ComponentProps<typeof WallStatePill>;

const renderPill = (
  props: Partial<{
    state: 'browsing';
    reserveOnly: boolean;
    backTarget: 'wall' | 'current' | null;
    latched: boolean;
    targetName: string | null;
  }> = {},
) => {
  const { state = 'browsing', reserveOnly, backTarget, latched, targetName } = props;
  return render(
    reserveOnly
      ? createElement(WallStatePill, { state, backTarget, latched, targetName, reserveOnly: true })
      : createElement(WallStatePill, { state, backTarget, latched, targetName, onPress: vi.fn() }),
  );
};

const pill = (container: HTMLElement) => container.querySelector('button') as HTMLElement;
/** Serialised styles of every view, for the handful of assertions about colour/size. */
const styles = (container: HTMLElement) =>
  [...container.querySelectorAll('div[data-style]')].map((node) => node.getAttribute('data-style') ?? '');

beforeEach(() => {
  driverState.value = { driver: null, name: null, litAgo: null };
});

describe('WallStatePill', () => {
  // The back chip (#7000): a back glyph, the word "Back", and the face of
  // whoever lit the wall when back lands on the lit climb. Neutral, because the
  // loud thing on screen is the wall button, the one control that changes
  // anything.
  it('shows a back glyph, "On the wall" and the wall driver’s face when back goes to the wall, on the neutral surface', () => {
    driverState.value = { driver: { userId: 'u1', avatarUrl: 'https://x/y.png' }, name: 'Sam', litAgo: null };
    const { container } = renderPill({ backTarget: 'wall' });

    expect(container.querySelector('[data-icon="undo"]')?.getAttribute('data-color')).toBe('#111');
    const avatar = container.querySelector('[data-driver-avatar="true"]') as HTMLElement;
    expect(avatar).toBeTruthy();
    expect(avatar.getAttribute('data-name')).toBe('Sam');
    expect(avatar.getAttribute('data-size')).toBe('20');
    // A pressable avatar inside a pressable chip would be a nested touchable.
    expect(avatar.getAttribute('data-user-id')).toBe('');
    expect(avatar.getAttribute('data-status')).toBe('none');
    expect(styles(container).some((style) => style.includes('#FF8A3D'))).toBe(false);
    expect(styles(container).some((style) => style.includes('"backgroundColor":"#FFF"'))).toBe(true);
    // QA #147: the word says where back goes.
    expect(container.textContent).toBe('playView.wallState.backOnWall');
    // The label says where back goes; the word is only for sighted climbers.
    expect(pill(container).getAttribute('data-label')).toBe('playView.wallState.backToWall');
  });

  it('keeps the glyph and "My pick", at least the 44pt touch width, with nobody to show', () => {
    const { container } = renderPill({ backTarget: 'current' });

    expect(container.querySelector('[data-icon="undo"]')).toBeTruthy();
    expect(container.textContent).toBe('playView.wallState.backMyPick');
    expect(container.querySelector('[data-driver-avatar="true"]')).toBeNull();
    expect(styles(container).some((style) => style.includes('"minWidth":44'))).toBe(true);
    expect(pill(container).getAttribute('data-label')).toBe('playView.wallState.backToCurrent');
  });

  // The face promises "back to what they lit". When back lands on the
  // climber's own climb and the wall shows something else, it would lie.
  it.each([
    ['current', 'current' as const],
    ['unset', null],
  ])('keeps the driver’s face off a back chip whose target is %s', (_label, backTarget) => {
    driverState.value = { driver: { userId: 'u1', avatarUrl: 'https://x/y.png' }, name: 'Sam', litAgo: null };
    const { container } = renderPill({ backTarget });

    expect(container.querySelector('[data-driver-avatar="true"]')).toBeNull();
    expect(pill(container).getAttribute('data-label')).toBe('playView.wallState.backToCurrent');
  });

  // QA #147: named to a screen reader, "Back to my pick: The Eyes".
  it('names the climb back goes to', () => {
    const mine = renderPill({ backTarget: 'current', targetName: 'The Eyes' });
    expect(pill(mine.container).getAttribute('data-label')).toBe(
      'playView.wallState.backToMyPickNamed:{"name":"The Eyes"}',
    );
    mine.unmount();
    const wall = renderPill({ backTarget: 'wall', targetName: 'The Eyes' });
    expect(pill(wall.container).getAttribute('data-label')).toBe(
      'playView.wallState.backToWallNamed:{"name":"The Eyes"}',
    );
  });

  it('says back to the wall without a face when nobody can be named', () => {
    const { container } = renderPill({ backTarget: 'wall' });

    expect(container.querySelector('[data-driver-avatar="true"]')).toBeNull();
    expect(pill(container).getAttribute('data-label')).toBe('playView.wallState.backToWall');
  });

  it('hints only the browsing rule, since the label already says where a tap goes', () => {
    const { container } = renderPill({});

    expect(pill(container).getAttribute('data-hint')).toBe('playView.wallState.browsingHint');
  });

  // "The wall stays where it is" is only true under a latch. A preview with
  // lighting on still lights each swipe, so its back chip promises nothing.
  it('drops the browsing hint when no latch holds the wall still', () => {
    const unlatched = renderPill({ backTarget: 'current', latched: false });
    expect(pill(unlatched.container).getAttribute('data-hint')).toBeNull();
    expect(pill(unlatched.container).getAttribute('data-label')).toBe('playView.wallState.backToCurrent');
  });

  it('hands a tap to the host, once', () => {
    const onPress = vi.fn();
    const { container } = render(createElement(WallStatePill, { state: 'browsing', onPress }));

    pill(container).click();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // hitSlop can't do this job: the touch area never extends past the parent's
  // bounds, and every ancestor of the chip (the header's measured leading flank)
  // sizes to its content — so the PRESSABLE itself has to carry the 44pt floor,
  // with the 32pt capsule centred inside it.
  it('gives the tap a real 44pt target rather than a 32pt chip with inert slop', () => {
    const { container } = renderPill({});
    const target = pill(container).getAttribute('data-style') ?? '';
    const capsule = styles(container).find((style) => style.includes('"borderRadius":9999')) ?? '';

    expect(target).toContain('"height":44');
    expect(capsule).toContain('"height":32');
  });

  it('answers a press — a ripple on Material, opacity and scale on Liquid Glass', () => {
    const { container } = renderPill({});
    const button = pill(container);

    expect(button.getAttribute('data-ripple')).toContain('"borderless":true');
    expect(button.getAttribute('data-ripple')).toContain('"color":"#111"');
    expect(button.getAttribute('data-style-pressed')).toContain('"opacity":0.6');
    expect(button.getAttribute('data-style')).not.toContain('"opacity":0.6');
  });

  // The swipe peek renders this copy so its header measures the same leading
  // flank as the header sliding out behind it — that parity is what stops the
  // climb name and its attribute glyphs stepping mid-swipe. It must hold the
  // space and nothing else: no tap, no words, nothing for a screen reader.
  describe('reserveOnly', () => {
    it("keeps the real chip's footprint so the reserved flank measures true", () => {
      const visible = renderPill({});
      const reserved = renderPill({ reserveOnly: true });

      // Same tree, same intrinsic size — a fixed-width spacer could not track a
      // translated word ("Back" / "Volver" / "Zurück" all differ).
      expect(reserved.container.textContent).toBe(visible.container.textContent);
      expect(pill(reserved.container).getAttribute('data-style')).toContain('"height":44');
      expect(pill(reserved.container).getAttribute('data-style')).toContain('"opacity":0');
    });

    it('claims nothing: untappable, unlabelled, hidden from assistive tech', () => {
      const onPress = vi.fn();
      // The props union already makes this call impossible to write — that is the
      // compile-time half. The cast reaches past it to the runtime guard sitting
      // behind it, which is what still protects a JavaScript caller.
      const { container } = render(
        createElement(WallStatePill, {
          state: 'browsing',
          onPress,
          reserveOnly: true,
        } as unknown as WallStatePillProps),
      );
      const button = pill(container);

      button.click();
      expect(onPress).not.toHaveBeenCalled();
      expect(button.getAttribute('data-role')).toBe('');
      expect(button.getAttribute('data-label')).toBeNull();
      expect(button.getAttribute('data-a11y-hidden')).toBe('true');
      expect(button.getAttribute('data-ripple')).toBe('');
      expect(button.getAttribute('data-style')).toContain('"pointerEvents":"none"');
    });
  });
});
