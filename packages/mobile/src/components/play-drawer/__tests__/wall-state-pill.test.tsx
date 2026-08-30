// @vitest-environment jsdom
// The header pill is the one place the drawer STATES what the wall is doing, so
// the assertions below are about truthfulness, not pixels: which state prints
// which words, that the words it can't print (there's no room beside the climb
// name) survive in the accessibility label, and that the tap it invites is
// actually reachable. Narration is the host's job now — see
// use-wall-state-announcer.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; style?: unknown };
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityElementsHidden?: boolean;
  pointerEvents?: string;
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
    pointerEvents,
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
        'data-pointer-events': pointerEvents ?? '',
        'data-ripple': android_ripple ? JSON.stringify(android_ripple) : '',
        'data-style': styleAttr(typeof style === 'function' ? style({ pressed: false }) : style),
        'data-style-pressed': styleAttr(typeof style === 'function' ? style({ pressed: true }) : style),
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
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
      key === 'mobile.boardPresence.drivenByA11y' ? `${opts?.name} is lighting the wall.` : key,
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
  BoardDriverAvatar: ({ userId, name, status }: { userId?: string | null; name?: string | null; status?: string }) =>
    createElement('div', {
      'data-driver-avatar': 'true',
      'data-user-id': userId ?? '',
      'data-name': name ?? '',
      'data-status': status,
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

import { WallStatePill } from '../WallStatePill';

const renderPill = (props: Partial<{ state: 'onWall' | 'live' | 'browsing'; reserveOnly: boolean }> = {}) =>
  render(
    createElement(WallStatePill, {
      state: props.state ?? 'browsing',
      onPress: vi.fn(),
      reserveOnly: props.reserveOnly,
    }),
  );

const pill = (container: HTMLElement) => container.querySelector('button') as HTMLElement;
/** Serialised styles of every view, for the handful of assertions about colour/size. */
const styles = (container: HTMLElement) =>
  [...container.querySelectorAll('div[data-style]')].map((node) => node.getAttribute('data-style') ?? '');

beforeEach(() => {
  driverState.value = { driver: null, name: null, litAgo: null };
});

describe('WallStatePill', () => {
  it('says "Browsing" in words and in the accent fill', () => {
    const { container } = renderPill({ state: 'browsing' });

    expect(container.textContent).toContain('playView.wallState.browsing');
    expect(container.querySelector('[data-icon="visibility"]')?.getAttribute('data-color')).toBe('#16111F');
    // Fill-only accent with dark ink on it — the one place the orange lives.
    expect(styles(container).some((style) => style.includes('"backgroundColor":"#FF8A3D"'))).toBe(true);
    expect(container.querySelector('span[data-color="#16111F"]')).toBeTruthy();
  });

  it('says "Live" beside the shared board-presence dot', () => {
    const { container } = renderPill({ state: 'live' });

    expect(container.textContent).toContain('playView.wallState.live');
    // The shared WALL_LIVE_DOT_SIZE, filled with the dedicated `live` role —
    // one dot vocabulary across every board-presence surface.
    expect(
      styles(container).some((style) => style.includes('"width":10') && style.includes('"backgroundColor":"#B45309"')),
    ).toBe(true);
    expect(container.querySelector('[data-driver-avatar="true"]')).toBeNull();
  });

  it('shows the driver instead of a label on the wall — the words ride the a11y label', () => {
    driverState.value = { driver: { userId: 'u1', avatarUrl: 'https://x/y.png' }, name: 'Marco', litAgo: '5m' };
    const { container } = renderPill({ state: 'onWall' });

    const avatar = container.querySelector('[data-driver-avatar="true"]') as HTMLElement;
    expect(avatar).toBeTruthy();
    expect(avatar.getAttribute('data-name')).toBe('Marco');
    // A pressable avatar inside a pressable pill would be a nested touchable;
    // the profile tap lives in the callout instead. The face still resolves
    // from `uri`, so passing null here costs nothing visually.
    expect(avatar.getAttribute('data-user-id')).toBe('');
    // Dropped out of the BLE glyph → the corner shows nothing, and recency moves
    // to the label below.
    expect(avatar.getAttribute('data-status')).toBe('none');
    expect(container.textContent).not.toContain('playView.wallState.onWall');

    const label = pill(container).getAttribute('data-label') ?? '';
    expect(label).toContain('playView.wallState.onWall');
    expect(label).toContain('Marco is lighting the wall.');
    expect(label).toContain('5m');
  });

  it('names an anonymous driver as such rather than dropping the attribution', () => {
    driverState.value = { driver: { userId: null, avatarUrl: null }, name: null, litAgo: null };
    const { container } = renderPill({ state: 'onWall' });

    expect(pill(container).getAttribute('data-label')).toContain('mobile.boardPresence.drivenByAnonA11y');
  });

  it('appends the "there is more here" hint to every state', () => {
    for (const state of ['onWall', 'live', 'browsing'] as const) {
      const { container } = renderPill({ state });
      expect(pill(container).getAttribute('data-hint')).toContain('playView.wallState.pillHint');
    }
  });

  it('is an indicator, not a toggle — a tap only opens the explainer', () => {
    const onPress = vi.fn();
    const { container } = render(createElement(WallStatePill, { state: 'browsing' as const, onPress }));

    pill(container).click();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // hitSlop can't do this job: the touch area never extends past the parent's
  // bounds, and every ancestor of the pill (the header's measured leading flank)
  // sizes to its content — so the PRESSABLE itself has to carry the 44pt floor,
  // with the 32pt capsule centred inside it.
  it('gives the tap a real 44pt target rather than a 32pt chip with inert slop', () => {
    const { container } = renderPill({ state: 'browsing' });
    const target = pill(container).getAttribute('data-style') ?? '';
    const capsule = styles(container).find((style) => style.includes('"borderRadius":9999')) ?? '';

    expect(target).toContain('"height":44');
    expect(capsule).toContain('"height":32');
  });

  it('answers a press — a ripple on Material, opacity and scale on Liquid Glass', () => {
    const { container } = renderPill({ state: 'browsing' });
    const button = pill(container);

    // Borderless, in the accent chip's own ink.
    expect(button.getAttribute('data-ripple')).toContain('"borderless":true');
    expect(button.getAttribute('data-ripple')).toContain('#16111F');
    expect(button.getAttribute('data-style-pressed')).toContain('"opacity":0.6');
    expect(button.getAttribute('data-style')).not.toContain('"opacity":0.6');
  });

  // The swipe peek renders this copy so its header measures the same leading
  // flank as the header sliding out behind it — that parity is what stops the
  // climb name and its attribute glyphs stepping mid-swipe. It must hold the
  // space and nothing else: no tap, no words, nothing for a screen reader.
  describe('reserveOnly', () => {
    it("keeps the real pill's footprint so the reserved flank measures true", () => {
      const visible = renderPill({ state: 'live' });
      const reserved = renderPill({ state: 'live', reserveOnly: true });

      // Same tree, same intrinsic size — a fixed-width spacer could not track a
      // translated label ('Live' / 'En vivo' / 'En direct' all differ).
      expect(reserved.container.textContent).toBe(visible.container.textContent);
      expect(pill(reserved.container).getAttribute('data-style')).toContain('"height":44');
      expect(pill(reserved.container).getAttribute('data-style')).toContain('"opacity":0');
    });

    it('claims nothing: untappable, unlabelled, hidden from assistive tech', () => {
      const onPress = vi.fn();
      const { container } = render(
        createElement(WallStatePill, { state: 'live' as const, onPress, reserveOnly: true }),
      );
      const button = pill(container);

      button.click();
      expect(onPress).not.toHaveBeenCalled();
      expect(button.getAttribute('data-role')).toBe('');
      expect(button.getAttribute('data-label')).toBeNull();
      expect(button.getAttribute('data-a11y-hidden')).toBe('true');
      expect(button.getAttribute('data-pointer-events')).toBe('none');
      expect(button.getAttribute('data-ripple')).toBe('');
    });
  });
});
