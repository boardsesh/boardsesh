// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { WallCapsuleDismissOptions } from '../use-wall-capsule-dismiss';

const spies = vi.hoisted(() => ({
  openWallPreview: vi.fn(),
  announce: vi.fn(),
  reduceMotion: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  colorScheme: 'dark' as 'dark' | 'light',
  nativeGlass: true,
  enterAnimation: vi.fn(() => ({})),
  panConsumed: false,
  viewerUserId: 'u-me' as string | null,
  isAuthenticated: true,
  // The sends after the grade; null leaves the grade alone, as for an unsent climb.
  sends: null as string | null,
  statsArgs: null as unknown,
  // The width the app-bar pill measures (Animated.View onLayout); undefined: no layout yet.
  layoutWidth: undefined as number | undefined,
}));

vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => spies.viewerUserId }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: spies.isAuthenticated }) }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: { boardName: 'kilter', layoutId: 1 } }),
}));
vi.mock('../use-climb-byline', () => ({
  useClimbStatsDetail: (climb: unknown, boardConfig: unknown, options: { statsEnabled?: boolean } = {}) => {
    spies.statsArgs = { climb, boardConfig, statsEnabled: options.statsEnabled };
    return options.statsEnabled === false ? null : spies.sends;
  },
}));

vi.mock('../use-wall-capsule-dismiss', () => ({
  useWallCapsuleDismiss: (options: WallCapsuleDismissOptions) => ({
    gesture: {},
    animatedStyle: {},
    onLayout: () => {},
    consumePanned: () => spies.panConsumed,
    dismiss: () => options.onDismiss?.(options.occurrenceKey),
  }),
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'div',
      {
        'data-gesture-root': true,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
  GestureDetector: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    style,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) =>
    createElement(
      'div',
      {
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-a11y-hidden': accessibilityElementsHidden,
        'data-important-for-a11y': importantForAccessibility,
      },
      children,
    ),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  }) =>
    createElement(
      'button',
      {
        'data-pressable': 'true',
        'data-role': accessibilityRole,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        onClick: onPress,
      },
      children,
    ),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
  AccessibilityInfo: { announceForAccessibility: spies.announce },
}));

type LayoutHandler = (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
function MockAnimatedView({
  children,
  style,
  onLayout,
}: {
  children?: ReactNode;
  style?: unknown;
  onLayout?: LayoutHandler;
}) {
  // Native onLayout supplies the slot's width; jsdom has no Yoga layout.
  useEffect(() => {
    if (onLayout && spies.layoutWidth !== undefined)
      onLayout({ nativeEvent: { layout: { width: spies.layoutWidth, height: 48 } } });
  }, [onLayout]);
  return createElement(
    'div',
    {
      'data-animated': 'true',
      'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
    },
    children,
  );
}
vi.mock('react-native-reanimated', () => ({
  default: { View: MockAnimatedView },
  FadeIn: { duration: spies.enterAnimation },
  useReducedMotion: () => spies.reduceMotion,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
  }),
}));

vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: (grade: string | null | undefined) => (grade === 'V5' ? '#FF0000' : undefined),
  DEFAULT_GRADE_COLOR: '#808080',
}));

vi.mock('../use-open-wall-preview', () => ({ useOpenWallPreview: () => spies.openWallPreview }));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => spies.nativeGlass }));
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({
    children,
    style,
    borderRadius,
    glassEffectStyle,
    tintColor,
  }: {
    children?: ReactNode;
    style?: unknown;
    borderRadius?: number;
    glassEffectStyle?: string;
    tintColor?: string;
  }) =>
    createElement(
      'div',
      {
        'data-glass-surface': 'true',
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-glass-radius': borderRadius,
        'data-glass-style': glassEffectStyle,
        'data-glass-tint': tintColor,
      },
      children,
    ),
}));
vi.mock('../../../lib/board-presence/presence-climb', () => ({
  boardPresenceClimbToClimb: (c: { climbUuid: string }) => ({ uuid: c.climbUuid, _converted: true }),
}));
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({
    uri,
    name,
    userId,
    size,
    status,
  }: {
    uri?: string | null;
    name?: string | null;
    userId?: string | null;
    size?: number;
    status?: string;
  }) =>
    createElement('span', {
      'data-driver-avatar': 'true',
      'data-uri': uri ?? '',
      'data-name': name ?? '',
      'data-user-id': userId === null ? 'null' : userId,
      'data-size': size,
      'data-status': status,
    }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: spies.variant,
    colorScheme: spies.colorScheme,
    systemColors: { label: '#111', secondaryBackground: '#222' },
    brandColors: { warning: '#FBBF24' },
    m3: {
      tertiary: '#FF8A3D',
      onTertiary: '#3A1D00',
      tertiaryContainer: '#FFDBCA',
      onTertiaryContainer: '#341100',
      onSurface: '#F5F2FB',
      onSurfaceVariant: '#A9A2B6',
      outlineVariant: '#4A4458',
    },
    m3SurfaceContainers: { high: '#2A2142', highest: '#322748' },
  }),
}));
// The capsule renders whatever `resolveGrade` returns (the app-wide "Show Boardsesh
// grades" swap). Stub it to the legacy behaviour: label = "<grade> 6C", colour = the
// mocked grade hue (#FF0000 for V5, else default). BoardPresenceClimb carries no
// Boardsesh grade today, so the toggle-on path still falls through to this.
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({
    boardseshActive: false,
    resolveGrade: (fields: { difficulty?: string | null }) => ({
      label: fields.difficulty ? `${fields.difficulty} 6C` : '',
      color: fields.difficulty === 'V5' ? '#FF0000' : '#808080',
      isBoardsesh: false,
    }),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({
    children,
    style,
    numberOfLines,
    ellipsizeMode,
    variant,
    color,
  }: {
    children?: ReactNode;
    style?: unknown;
    numberOfLines?: number;
    ellipsizeMode?: string;
    variant?: string;
    color?: string;
  }) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-variant': variant,
        'data-color': color,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-lines': numberOfLines,
        'data-ellipsize': ellipsizeMode,
      },
      children,
    ),
}));
vi.mock('../AccessoryClimbThumbnail', () => ({
  AccessoryClimbThumbnail: ({
    climb,
    boardConfig,
    size,
  }: {
    climb: { frames: string; mirrored?: boolean | null };
    boardConfig: { boardName: string } | null;
    size?: number;
  }) =>
    createElement('span', {
      'data-thumbnail': climb.frames,
      'data-mirrored': String(climb.mirrored),
      'data-board': boardConfig?.boardName,
      'data-size': size,
    }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'div',
      {
        'data-label-viewer': 'true',
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    feedback,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    accessibilityActions,
    onAccessibilityAction,
    hitSlop,
    style,
    rippleColor,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    feedback?: string;
    rippleColor?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityActions?: readonly { name: string; label?: string }[];
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    hitSlop?: unknown;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        'data-pressable': 'true',
        'data-pressable-surface': 'true',
        'data-feedback': feedback,
        'data-ripple': rippleColor,
        'data-role': accessibilityRole,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-actions': JSON.stringify(accessibilityActions),
        'data-hit-slop': hitSlop ? JSON.stringify(hitSlop) : undefined,
        onKeyDown: () => onAccessibilityAction?.({ nativeEvent: { actionName: 'dismiss' } }),
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { none: 0, sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string, alpha: number) => `${color}:${alpha}` }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));

import { WallStatusCapsule } from '../WallStatusCapsule';
import { NativeHeaderActionContext, NativeTitleMaxWidthContext } from '../../chrome/native-header-action-context';

function makeClimb(over: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid: 'wall-1',
    name: 'Wax On',
    grade: 'V5',
    frames: '',
    angle: 40,
    setter: 'someone',
    sentByDisplayName: 'Casey',
    sentByAvatarUrl: 'https://example.com/casey.jpg',
    sentByUserId: 'u-casey',
    sentAt: '2026-01-01T00:00:00Z',
    seq: 1,
    ...over,
  } as BoardPresenceClimb;
}

describe('WallStatusCapsule', () => {
  beforeEach(() => {
    spies.openWallPreview.mockClear();
    spies.enterAnimation.mockClear();
    spies.announce.mockClear();
    spies.reduceMotion = false;
    spies.variant = 'liquidGlass';
    spies.colorScheme = 'dark';
    spies.nativeGlass = true;
    spies.panConsumed = false;
    spies.viewerUserId = 'u-me';
    spies.isAuthenticated = true;
    spies.sends = null;
    spies.statsArgs = null;
    spies.layoutWidth = undefined;
  });

  it('keeps the climb name intrinsic and shrinkable inside the native header', () => {
    const { container, getByText } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={makeClimb()} />
      </NativeHeaderActionContext.Provider>,
    );
    const nameViewer = container.querySelector('[data-label-viewer]');
    const nameStyle = JSON.parse(nameViewer?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    const glassSurface = container.querySelector('[data-glass-surface]');
    const capsuleStyle = JSON.parse(glassSurface?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

    expect(getByText('Wax On')).toBeTruthy();
    expect(nameStyle).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(nameStyle.flex).toBeUndefined();
    // UIKit's 38pt bar slot, the same height as the action groups beside it.
    expect(capsuleStyle).toMatchObject({ height: 38 });
    expect(glassSurface?.getAttribute('data-glass-radius')).toBe('19');
    expect(getByText('Wax On').getAttribute('data-variant')).toBe('caption1');
    const rowStyle = JSON.parse(container.querySelector('[data-pressable]')?.getAttribute('data-style') ?? '{}');
    expect(rowStyle).toMatchObject({ gap: 6, paddingStart: 4, paddingEnd: 10 });
    expect(container.querySelector('[data-driver-avatar]')?.getAttribute('data-size')).toBe('24');
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-feedback')).toBe('none');
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(spies.enterAnimation).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'retains its native title view while the wall climb changes (native glass: %s)',
    (nativeGlass) => {
      spies.nativeGlass = nativeGlass;
      const { container, rerender } = render(
        <NativeHeaderActionContext.Provider value={true}>
          <WallStatusCapsule climb={makeClimb()} />
        </NativeHeaderActionContext.Provider>,
      );
      const originalTitleView = container.firstElementChild;
      rerender(
        <NativeHeaderActionContext.Provider value={true}>
          <WallStatusCapsule
            climb={makeClimb({
              climbUuid: 'wall-2',
              name: 'The next long climb on the wall',
              sentByDisplayName: 'Alex',
              sentByAvatarUrl: 'https://example.com/alex.jpg',
              sentByUserId: 'u-alex',
            })}
          />
        </NativeHeaderActionContext.Provider>,
      );

      expect(container.firstElementChild).toBe(originalTitleView);
      expect(container.textContent).toContain('The next long climb on the wall');
      const avatar = container.querySelector('[data-driver-avatar]')!;
      expect(avatar.getAttribute('data-name')).toBe('Alex');
      expect(avatar.getAttribute('data-uri')).toBe('https://example.com/alex.jpg');
      fireEvent.click(avatar);
      expect(spies.openWallPreview).toHaveBeenCalledOnce();
      expect(spies.openWallPreview).toHaveBeenCalledWith({ uuid: 'wall-2', _converted: true });
      expect(spies.enterAnimation).not.toHaveBeenCalled();
    },
  );

  it('preserves the fallback capsule entering animation outside a native header', () => {
    spies.nativeGlass = false;
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);

    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-feedback')).toBe('scale');
    expect(spies.enterAnimation).toHaveBeenCalledWith(180);
  });

  it('lets a long native title shrink its name while retaining the avatar', () => {
    const { container, getByText } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={makeClimb({ name: 'Lightest Pair of Shorts' })} />
      </NativeHeaderActionContext.Provider>,
    );
    for (const carrier of [
      container.firstElementChild,
      container.querySelector('[data-glass-surface]'),
      container.querySelector('[data-pressable]'),
      container.querySelector('[data-label-viewer]'),
    ]) {
      const carrierStyle = JSON.parse(carrier?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
      expect(carrierStyle).toMatchObject({ flexShrink: 1, minWidth: 0 });
    }
    const avatarStyle = JSON.parse(
      container.querySelector('[data-driver-avatar]')?.parentElement?.getAttribute('data-style') ?? '{}',
    ) as Record<string, unknown>;
    const nameStyle = JSON.parse(getByText('Lightest Pair of Shorts').getAttribute('data-style') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(avatarStyle.flexShrink).toBe(0);
    expect(nameStyle).toMatchObject({ flexShrink: 1, minWidth: 0 });
    // A capped title ends the name in an ellipsis instead of clipping it.
    expect(getByText('Lightest Pair of Shorts').getAttribute('data-lines')).toBe('1');
    expect(getByText('Lightest Pair of Shorts').getAttribute('data-ellipsize')).toBe('tail');
    fireEvent.click(getByText('Lightest Pair of Shorts'));
    expect(spies.openWallPreview).toHaveBeenCalledOnce();
  });

  it.each([
    // A 320pt frame (Display Zoom) beside the matched islands.
    [96, true],
    [129, true],
    // From a 130pt bound (402pt with the matched islands) the face says who lit it.
    [130, false],
    [151, false],
    [178, false],
    [undefined, false],
  ])("shows the sender's face only from a 130pt bound: %s (no face: %s)", (titleMaxWidth, compact) => {
    const { container, getByText } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <NativeTitleMaxWidthContext.Provider value={titleMaxWidth}>
          <WallStatusCapsule climb={makeClimb()} />
        </NativeTitleMaxWidthContext.Provider>
      </NativeHeaderActionContext.Provider>,
    );
    expect(container.querySelector('[data-driver-avatar]') == null).toBe(compact);
    expect(getByText('Wax On')).toBeTruthy();
    const rowStyle = JSON.parse(container.querySelector('[data-pressable]')?.getAttribute('data-style') ?? '{}');
    expect(rowStyle.paddingStart).toBe(compact ? 10 : 4);
  });

  it('renders without the entering animation when Reduce Motion is on', () => {
    spies.nativeGlass = false;
    spies.reduceMotion = true;
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('Wax On')).not.toBeNull();
    expect(spies.enterAnimation).not.toHaveBeenCalled();
  });

  it('keeps floating native glass static instead of entering through an opacity fade', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-radius')).toBe('19');
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(spies.enterAnimation).not.toHaveBeenCalled();
  });

  it.each(['dark', 'light'] as const)(
    'uses one regular amber-tinted glass surface in %s mode without painting over it',
    (scheme) => {
      spies.colorScheme = scheme;
      const { container } = render(
        <NativeHeaderActionContext.Provider value={true}>
          <WallStatusCapsule climb={makeClimb()} />
        </NativeHeaderActionContext.Provider>,
      );
      const surfaces = container.querySelectorAll('[data-glass-surface]');
      expect(surfaces).toHaveLength(1);
      expect(surfaces[0].getAttribute('data-glass-style')).toBe('regular');
      expect(surfaces[0].getAttribute('data-glass-tint')).toBe('#FBBF24:0.14');
      // No parent or surface paint/clip can cover the native refractive lens.
      for (const carrier of [container.firstElementChild, surfaces[0]]) {
        const carrierStyle = JSON.parse(carrier?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
        expect(carrierStyle.backgroundColor).toBeUndefined();
        expect(carrierStyle.borderColor).toBeUndefined();
        expect(carrierStyle.borderWidth).toBeUndefined();
        expect(carrierStyle.overflow).toBeUndefined();
      }
      expect(surfaces[0].querySelector('[data-style*="backgroundColor"]')).toBeNull();
      fireEvent.click(container.querySelector('[data-pressable]') as Element);
      expect(spies.openWallPreview).toHaveBeenCalledOnce();
    },
  );

  it('preserves the opaque amber fallback when native glass is unavailable or transparency is reduced', () => {
    spies.nativeGlass = false;
    const { container } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={makeClimb()} />
      </NativeHeaderActionContext.Provider>,
    );
    expect(container.querySelector('[data-glass-surface]')).toBeNull();
    const capsuleStyle = JSON.parse(container.firstElementChild?.getAttribute('data-style') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(capsuleStyle).toMatchObject({
      height: 38,
      borderRadius: 19,
      backgroundColor: '#222',
      borderColor: '#FBBF24:0.35',
      borderWidth: 1,
      overflow: 'hidden',
    });
    expect(container.querySelector('[data-style*="#FBBF24:0.14"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-pressable]') as Element);
    expect(spies.openWallPreview).toHaveBeenCalledOnce();
  });

  const capsuleLines = (root: HTMLElement) =>
    [...root.querySelectorAll('[data-pressable] [data-text]')].map((node) => node.textContent);

  it("puts someone else's climb over its grade and who lit it, with no stats read (#7281)", () => {
    spies.sends = '1.4k sends';
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(capsuleLines(container)).toEqual(['Wax On', 'V5 6C', ' · Casey']);
    expect(container.querySelector('[data-driver-avatar]')?.getAttribute('data-name')).toBe('Casey');
    expect(spies.statsArgs).toMatchObject({ statsEnabled: false });
  });

  it('puts your own climb over its grade and sends, with no face (#7281)', () => {
    spies.viewerUserId = 'u-casey';
    spies.sends = '1.4k sends';
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(capsuleLines(container)).toEqual(['Wax On', 'V5 6C', ' · 1.4k sends']);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
    // The live stats read the converted climb on the active board.
    expect(spies.statsArgs).toEqual({
      climb: { uuid: 'wall-1', _converted: true },
      boardConfig: { boardName: 'kilter', layoutId: 1 },
      statsEnabled: true,
    });
  });

  it('never cuts the grade: only the fact after it gives way', () => {
    spies.viewerUserId = 'u-casey';
    spies.sends = '1.4k sends';
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
    const grade = JSON.parse(getByText('V5 6C').getAttribute('data-style') ?? '{}');
    const detail = [...container.querySelectorAll('[data-text]')].find(
      (node) => node.textContent === ' · 1.4k sends',
    ) as HTMLElement;
    expect(grade.flexShrink).toBe(0);
    expect(JSON.parse(detail.getAttribute('data-style') ?? '{}')).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(detail.getAttribute('data-lines')).toBe('1');
    expect(detail.getAttribute('data-ellipsize')).toBe('tail');
  });

  it("shows the grade alone when the reporter sent no angle, so no other angle's sends leak in", () => {
    spies.viewerUserId = 'u-casey';
    spies.sends = '1.4k sends';
    const { container } = render(<WallStatusCapsule climb={makeClimb({ angle: null })} />);
    expect(capsuleLines(container)).toEqual(['Wax On', 'V5 6C']);
  });

  it('shows the grade in place of a missing climb name, once', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb({ name: null })} />);
    expect(capsuleLines(container)).toEqual(['V5 6C', 'Casey']);
  });

  it('shows the grade alone, no face, while a signed-in climber’s id is still loading', () => {
    spies.viewerUserId = null;
    spies.sends = '1.4k sends';
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(capsuleLines(container)).toEqual(['Wax On', 'V5 6C']);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
    expect(spies.statsArgs).toMatchObject({ statsEnabled: false });
  });

  it("reads a signed-out climber's view of a named sender as someone else's climb", () => {
    spies.viewerUserId = null;
    spies.isAuthenticated = false;
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(capsuleLines(container)).toEqual(['Wax On', 'V5 6C', ' · Casey']);
    expect(container.querySelector('[data-driver-avatar]')).not.toBeNull();
  });

  it("says an unnamed sender's climb in sends, with no face", () => {
    spies.sends = '1.4k sends';
    const { container } = render(
      <WallStatusCapsule climb={makeClimb({ sentByDisplayName: null, sentByUserId: 'u-unnamed' })} />,
    );
    expect(capsuleLines(container)).toEqual(['Wax On', 'V5 6C', ' · 1.4k sends']);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
  });

  it('lets the age cut only in a title too narrow for it (a 320pt Display Zoom bar)', () => {
    const history = { kind: 'history' as const, ageLabel: '20m', ageByline: '20m ago' };
    const ageStyle = (bound: number) => {
      const { container, unmount } = render(
        <NativeHeaderActionContext.Provider value={true}>
          <NativeTitleMaxWidthContext.Provider value={bound}>
            <WallStatusCapsule climb={makeClimb()} presentation={history} />
          </NativeTitleMaxWidthContext.Provider>
        </NativeHeaderActionContext.Provider>,
      );
      const age = [...container.querySelectorAll('[data-text]')].find((node) => node.textContent === ' · 20m ago');
      const style = JSON.parse(age?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
      unmount();
      return style;
    };
    expect(ageStyle(151).flexShrink).toBe(0);
    expect(ageStyle(96)).toMatchObject({ flexShrink: 1, minWidth: 0 });
  });

  it('keeps the name and avatar when the climb grade is null', () => {
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb({ grade: null })} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('Wax On')).not.toBeNull();
    expect(container.querySelector('[data-driver-avatar]')).not.toBeNull();
  });

  it('leads with the sender avatar as decoration within the single preview button', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    const avatar = container.querySelector('[data-driver-avatar]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('data-uri')).toBe('https://example.com/casey.jpg');
    expect(avatar?.getAttribute('data-name')).toBe('Casey');
    expect(avatar?.getAttribute('data-size')).toBe('24');
    expect(avatar?.getAttribute('data-user-id')).toBe('null');
    expect(avatar?.getAttribute('data-status')).toBe('none');
    expect(avatar?.parentElement?.getAttribute('data-a11y-hidden')).toBe('true');
    expect(avatar?.parentElement?.getAttribute('data-important-for-a11y')).toBe('no-hide-descendants');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector('[data-pressable]')?.firstElementChild).toBe(avatar?.parentElement);
    expect(container.querySelector('[data-icon="profile.fill"]')).toBeNull();
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-label')).toContain('Casey');
    fireEvent.click(avatar!);
    expect(spies.openWallPreview).toHaveBeenCalledOnce();
    expect(spies.openWallPreview).toHaveBeenCalledWith({ uuid: 'wall-1', _converted: true });
  });

  it('passes a name-only sender to the avatar for its initials fallback', () => {
    const { container } = render(
      <WallStatusCapsule climb={makeClimb({ sentByAvatarUrl: null, sentByDisplayName: '  Casey  ' })} />,
    );
    const avatar = container.querySelector('[data-driver-avatar]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('data-uri')).toBe('');
    expect(avatar?.getAttribute('data-name')).toBe('Casey');
    expect(container.querySelector('[data-icon="profile.fill"]')).toBeNull();
  });

  it.each([null, 'u-only'])('draws no face for a sender with no photo or name (userId: %s)', (sentByUserId) => {
    const climb = makeClimb({ sentByDisplayName: null, sentByAvatarUrl: null, sentByUserId });
    const { container } = render(<WallStatusCapsule climb={climb} />);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
    expect(container.querySelector('[data-icon="profile.fill"]')).toBeNull();
    expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
    // Nothing says who lit it, so the name starts at the inset.
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-style')).toContain('"paddingStart":10');
  });

  it('opens the read-only wall preview (converted climb) on tap', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    fireEvent.click(container.querySelector('[data-pressable]') as Element);
    expect(spies.openWallPreview).toHaveBeenCalledWith({ uuid: 'wall-1', _converted: true });
  });

  it('exposes a button label that names the climb and the sender', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    const pressable = container.querySelector('[data-pressable]');
    expect(pressable?.getAttribute('data-role')).toBe('button');
    expect(pressable?.getAttribute('data-label')).toContain('Wax On');
    expect(pressable?.getAttribute('data-label')).toContain('Casey');
  });

  it('announces the wall climb to assistive tech after the debounce', () => {
    vi.useFakeTimers();
    try {
      render(<WallStatusCapsule climb={makeClimb()} />);
      expect(spies.announce).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);
      expect(spies.announce).toHaveBeenCalledWith(expect.stringContaining('Wax On'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the grade and a whole age under the name of a climb lit with no live link, so it never reads as live', () => {
    const { container } = render(
      <WallStatusCapsule
        climb={makeClimb()}
        presentation={{ kind: 'history', ageLabel: '20m', ageByline: '20m ago' }}
      />,
    );
    const lines = [...container.querySelectorAll('[data-pressable] [data-text]')].map((node) => node.textContent);
    expect(lines).toEqual(['Wax On', 'V5 6C', ' · 20m ago']);
    // A cut age would be a wrong age: it never gives way.
    const age = [...container.querySelectorAll('[data-text]')].find((node) => node.textContent === ' · 20m ago');
    expect(JSON.parse(age?.getAttribute('data-style') ?? '{}').flexShrink).toBe(0);
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-label')).toBe(
      'mobile.boardPresence.stripHistoryA11yLabelWithSender:Wax On,V5 6C,20m,Casey',
    );
  });

  it('shows the age when an older reporter has no grade', () => {
    const { getByText } = render(
      <WallStatusCapsule
        climb={makeClimb({ grade: null })}
        presentation={{ kind: 'history', ageLabel: 'now', ageByline: 'Just now' }}
      />,
    );
    expect(getByText('Just now')).toBeTruthy();
  });

  it('does not announce history or its changing age as a new live climb', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <WallStatusCapsule
          climb={makeClimb()}
          presentation={{ kind: 'history', ageLabel: '20m', ageByline: '20m ago' }}
        />,
      );
      vi.advanceTimersByTime(600);
      rerender(
        <WallStatusCapsule
          climb={makeClimb()}
          presentation={{ kind: 'history', ageLabel: '21m', ageByline: '21m ago' }}
        />,
      );
      vi.advanceTimersByTime(600);
      expect(spies.announce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['liquidGlass', 'material'] as const)('offers a named dismiss action on %s', (variant) => {
    spies.variant = variant;
    const onDismiss = vi.fn();
    const { container } = render(
      <WallStatusCapsule climb={makeClimb()} occurrenceKey="board:7:wall-1" onDismiss={onDismiss} />,
    );
    const pressable = container.querySelector('[data-pressable]');
    expect(JSON.parse(pressable?.getAttribute('data-actions') ?? 'null')).toEqual([
      { name: 'dismiss', label: 'mobile.boardPresence.stripDismiss' },
    ]);
    expect(pressable?.getAttribute('data-hint')).toBe('mobile.boardPresence.stripDismissHint');
    fireEvent.keyDown(pressable!);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:7:wall-1');
    expect(spies.openWallPreview).not.toHaveBeenCalled();
  });

  it('has no × on Liquid Glass: a swipe or the screen-reader action hides it (#7281)', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <WallStatusCapsule climb={makeClimb()} occurrenceKey="board:7:wall-1" onDismiss={onDismiss} />,
    );
    expect(container.querySelector('[data-label="mobile.boardPresence.stripDismiss"]')).toBeNull();
    expect(container.querySelector('[data-icon="close"]')).toBeNull();
    // The whole capsule is the swipe target.
    expect(container.querySelector('[data-gesture-root]')).not.toBeNull();
    // Without the ×, the text runs to the capsule's trailing inset.
    const main = container.querySelector('[data-pressable]');
    expect(JSON.parse(main?.getAttribute('data-style') ?? '{}').paddingEnd).toBe(10);
  });

  it('is not swipeable and offers no Hide when the capsule cannot be hidden', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-gesture-root]')).toBeNull();
    const pressable = container.querySelector('[data-pressable]');
    expect(pressable?.getAttribute('data-actions')).toBeNull();
    expect(pressable?.getAttribute('data-hint')).toBe('mobile.boardPresence.stripA11yHint');
  });

  it('drops the tap that follows an activated swipe', () => {
    spies.panConsumed = true;
    const { container } = render(<WallStatusCapsule climb={makeClimb()} onDismiss={vi.fn()} />);
    fireEvent.click(container.querySelector('[data-pressable]')!);
    expect(spies.openWallPreview).not.toHaveBeenCalled();
    spies.panConsumed = false;
    fireEvent.click(container.querySelector('[data-pressable]')!);
    expect(spies.openWallPreview).toHaveBeenCalledOnce();
  });

  it('keeps dismissible native title wrappers intrinsic and stable across lighting events', () => {
    const onDismiss = vi.fn();
    const wrap = (climb: BoardPresenceClimb, occurrenceKey: string) => (
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={climb} occurrenceKey={occurrenceKey} onDismiss={onDismiss} />
      </NativeHeaderActionContext.Provider>
    );
    const { container, rerender } = render(wrap(makeClimb(), 'board:1:wall-1'));
    const root = container.firstElementChild;
    const animated = container.querySelector('[data-animated]');
    for (const wrapper of [root, animated]) {
      const style = JSON.parse(wrapper?.getAttribute('data-style') ?? '{}');
      expect(style).toMatchObject({ flexShrink: 1, minWidth: 0, maxWidth: '100%' });
      expect(style.flex).toBeUndefined();
      expect(style.width).toBeUndefined();
    }
    rerender(wrap(makeClimb({ climbUuid: 'wall-2', name: 'Next climb', seq: 2 }), 'board:2:wall-2'));
    expect(container.firstElementChild).toBe(root);
    expect(container.querySelector('[data-animated]')).toBe(animated);
    expect(spies.enterAnimation).not.toHaveBeenCalled();
  });

  it('renders the Liquid Glass Pressable pill (not the Material pill) on iOS', () => {
    const { container, queryByText } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(container.querySelector('[data-pressable-surface]')).not.toBeNull();
    // The glass pill carries the "lit" cue as the amber tint — no visible overline.
    expect(queryByText('mobile.boardPresence.stripOverline')).toBeNull();
  });

  describe('Material (the Android Climbs app-bar pill)', () => {
    beforeEach(() => {
      spies.variant = 'material';
    });
    const pill = (root: HTMLElement) => root.querySelector('[data-animated]') as HTMLElement;
    const styleOf = (element: Element | null | undefined) =>
      JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    const lines = (root: HTMLElement) =>
      [...root.querySelectorAll('[data-pressable] [data-text]')].map((node) => node.textContent);
    const litClimb = (over: Partial<BoardPresenceClimb> = {}) => makeClimb({ frames: 'p1r12p2r13', ...over });

    it('is one 48dp full-radius pill in the amber tertiary container, filling the slot up to 280dp', () => {
      const { container } = render(<WallStatusCapsule climb={litClimb()} />);
      expect(styleOf(pill(container))).toMatchObject({
        height: 48,
        width: '100%',
        maxWidth: 280,
        borderRadius: 9999,
        overflow: 'hidden',
        backgroundColor: '#FFDBCA',
      });
      // The fill carries "lit": no accent rail, no overline.
      expect(container.querySelector('[data-style*="#FF8A3D"]')).toBeNull();
      expect(container.textContent).not.toContain('stripOverlineWithSender');
      expect(container.querySelectorAll('button')).toHaveLength(1);
      // The M3 state layer is the container's ink, so the ripple shows on amber.
      expect(container.querySelector('[data-pressable-surface]')?.getAttribute('data-ripple')).toBe('#341100');
    });

    it('puts the name in titleSmall over grade · who lit it in labelMedium, all in onTertiaryContainer', () => {
      const { container, getByText } = render(<WallStatusCapsule climb={litClimb()} />);
      expect(lines(container)).toEqual(['Wax On', 'V5 6C', ' · Casey']);
      expect(getByText('Wax On').getAttribute('data-variant')).toBe('label');
      expect(styleOf(getByText('Wax On'))).toMatchObject({ fontWeight: '500' });
      expect(getByText('V5 6C').getAttribute('data-variant')).toBe('footnote');
      expect(styleOf(getByText('V5 6C'))).toMatchObject({ fontWeight: '500' });
      // The grade reads in the container's ink, never its own hue on the amber fill.
      for (const text of ['Wax On', 'V5 6C', ' · Casey']) {
        const node = [...container.querySelectorAll('[data-text]')].find((line) => line.textContent === text);
        expect(node?.getAttribute('data-color')).toBe('#341100');
      }
      // Someone else's climb reads no stats, as on glass.
      expect(spies.statsArgs).toMatchObject({ statsEnabled: false });
    });

    it("says the same facts as glass: your own or an unnamed climb's sends, the age for history", () => {
      spies.viewerUserId = 'u-casey';
      spies.sends = '1.4k sends';
      const own = render(<WallStatusCapsule climb={makeClimb()} />);
      expect(lines(own.container)).toEqual(['Wax On', 'V5 6C', ' · 1.4k sends']);
      expect(spies.statsArgs).toMatchObject({ statsEnabled: true });
      own.unmount();
      spies.viewerUserId = 'u-me';
      const unnamed = render(
        <WallStatusCapsule climb={makeClimb({ sentByDisplayName: null, sentByUserId: 'u-unnamed' })} />,
      );
      expect(lines(unnamed.container)).toEqual(['Wax On', 'V5 6C', ' · 1.4k sends']);
      unnamed.unmount();
      spies.viewerUserId = null;
      const pending = render(<WallStatusCapsule climb={makeClimb()} />);
      expect(lines(pending.container)).toEqual(['Wax On', 'V5 6C']);
      pending.unmount();
      spies.viewerUserId = 'u-casey';
      const history = render(
        <WallStatusCapsule
          climb={makeClimb()}
          presentation={{ kind: 'history', ageLabel: '20m', ageByline: '20m ago' }}
        />,
      );
      expect(lines(history.container)).toEqual(['Wax On', 'V5 6C', ' · 20m ago']);
    });

    it('never cuts the grade: only the fact after it gives way', () => {
      const { container, getByText } = render(
        <WallStatusCapsule
          climb={makeClimb({ name: 'A very long climb name that will not fit', sentByDisplayName: 'Alexandra' })}
        />,
      );
      expect(styleOf(getByText('V5 6C')).flexShrink).toBe(0);
      const detail = [...container.querySelectorAll('[data-text]')].find(
        (node) => node.textContent === ' · Alexandra',
      ) as HTMLElement;
      expect(styleOf(detail)).toMatchObject({ flexShrink: 1, minWidth: 0 });
      expect(detail.getAttribute('data-ellipsize')).toBe('tail');
    });

    it.each([
      // Before its first layout neither shows, so a narrow slot never flashes one.
      [undefined, false, false],
      [96, false, false],
      [129, false, false],
      // Room for the thumbnail, not both: the byline still names the sender.
      [130, true, false],
      [179, true, false],
      // From 180dp the sender's face joins the thumbnail.
      [180, true, true],
      [200, true, true],
    ])('leads with the thumbnail from 130dp and adds the face from 180dp: %s', (width, thumbnailShown, faceShown) => {
      spies.layoutWidth = width;
      const { container } = render(<WallStatusCapsule climb={litClimb({ mirrored: true })} />);
      const thumbnail = container.querySelector('[data-thumbnail]');
      const face = container.querySelector('[data-driver-avatar]');
      expect(thumbnail != null).toBe(thumbnailShown);
      expect(face != null).toBe(faceShown);
      expect(lines(container)).toContain(' · Casey');
      if (thumbnail) {
        // The lit climb's own holds and mirror flag, on the board presence is scoped to,
        // in the MiniPlayer's default 40dp slot, decoration inside the one button.
        expect(thumbnail.getAttribute('data-thumbnail')).toBe('p1r12p2r13');
        expect(thumbnail.getAttribute('data-mirrored')).toBe('true');
        expect(thumbnail.getAttribute('data-board')).toBe('kilter');
        expect(thumbnail.getAttribute('data-size')).toBeNull();
        expect(thumbnail.closest('[data-a11y-hidden="true"]')).not.toBeNull();
      }
      if (face) {
        // Glass's face: the same avatar and size, after the thumbnail.
        expect(face.getAttribute('data-size')).toBe('24');
        expect(face.getAttribute('data-name')).toBe('Casey');
        expect(thumbnail?.compareDocumentPosition(face)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      }
    });

    it('shows no face for your own climb, only the thumbnail and its sends', () => {
      spies.layoutWidth = 200;
      spies.viewerUserId = 'u-casey';
      spies.sends = '406 sends';
      const { container } = render(<WallStatusCapsule climb={litClimb()} />);
      expect(container.querySelector('[data-thumbnail]')).not.toBeNull();
      expect(container.querySelector('[data-driver-avatar]')).toBeNull();
      expect(lines(container)).toEqual(['Wax On', 'V5 6C', ' · 406 sends']);
    });

    it('shows no thumbnail for a reporter that sent no holds, and the face on glass terms', () => {
      spies.layoutWidth = 130;
      const { container } = render(<WallStatusCapsule climb={makeClimb({ frames: null })} />);
      expect(container.querySelector('[data-thumbnail]')).toBeNull();
      expect(container.querySelector('[data-driver-avatar]')).not.toBeNull();
      expect(lines(container)).toEqual(['Wax On', 'V5 6C', ' · Casey']);
    });

    it('lets the age cut only in a pill too narrow for it', () => {
      spies.layoutWidth = 96;
      const { container } = render(
        <WallStatusCapsule
          climb={makeClimb()}
          presentation={{ kind: 'history', ageLabel: '20m', ageByline: '20m ago' }}
        />,
      );
      const age = [...container.querySelectorAll('[data-text]')].find((node) => node.textContent === ' · 20m ago');
      expect(styleOf(age)).toMatchObject({ flexShrink: 1, minWidth: 0 });
    });

    it('opens the read-only wall preview on tap', () => {
      const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
      fireEvent.click(container.querySelector('[data-pressable-surface]')!);
      expect(spies.openWallPreview).toHaveBeenCalledWith({ uuid: 'wall-1', _converted: true });
    });

    it('hides by swipe or the screen-reader action, with no × button', () => {
      const onDismiss = vi.fn();
      const { container } = render(
        <WallStatusCapsule
          climb={makeClimb()}

          occurrenceKey="board:7:wall-1"
          onDismiss={onDismiss}
        />,
      );
      expect(container.querySelector('[data-label="mobile.boardPresence.stripDismiss"]')).toBeNull();
      expect(container.querySelector('[data-icon="close"]')).toBeNull();
      expect(container.querySelectorAll('button')).toHaveLength(1);
      // The swipe wrapper fills the slot under the same 280dp cap.
      expect(styleOf(container.querySelector('[data-gesture-root]'))).toMatchObject({
        width: '100%',
        maxWidth: 280,
      });
      const pressable = container.querySelector('[data-pressable-surface]')!;
      expect(pressable.getAttribute('data-role')).toBe('button');
      expect(pressable.getAttribute('data-label')).toContain('Wax On');
      expect(pressable.getAttribute('data-hint')).toBe('mobile.boardPresence.stripDismissHint');
      expect(JSON.parse(pressable.getAttribute('data-actions') ?? '[]')).toEqual([
        { name: 'dismiss', label: 'mobile.boardPresence.stripDismiss' },
      ]);
      fireEvent.keyDown(pressable);
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:7:wall-1');
      expect(spies.openWallPreview).not.toHaveBeenCalled();
    });
  });
});
