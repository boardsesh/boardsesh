// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

const spies = vi.hoisted(() => ({
  openWallPreview: vi.fn(),
  announce: vi.fn(),
  reduceMotion: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  colorScheme: 'dark' as 'dark' | 'light',
  nativeGlass: true,
  enterAnimation: vi.fn(() => ({})),
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

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-animated': 'true' }, children),
  },
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
  }: {
    children?: ReactNode;
    style?: unknown;
    numberOfLines?: number;
    ellipsizeMode?: string;
    variant?: string;
  }) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-variant': variant,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-lines': numberOfLines,
        'data-ellipsize': ellipsizeMode,
      },
      children,
    ),
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
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    feedback?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        'data-pressable': 'true',
        'data-pressable-surface': 'true',
        'data-feedback': feedback,
        'data-role': accessibilityRole,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
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
    expect(getByText('V5 6C')).toBeTruthy();
    expect(nameStyle).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(nameStyle.flex).toBeUndefined();
    // UIKit's 38pt bar slot, the same height as the action groups beside it.
    expect(capsuleStyle).toMatchObject({ height: 38 });
    expect(glassSurface?.getAttribute('data-glass-radius')).toBe('19');
    // 12pt caption text and a tighter row leave the name more of the slot.
    expect(getByText('Wax On').getAttribute('data-variant')).toBe('caption1');
    expect(getByText('V5 6C').getAttribute('data-variant')).toBe('caption1');
    const rowStyle = JSON.parse(container.querySelector('[data-pressable]')?.getAttribute('data-style') ?? '{}');
    expect(rowStyle).toMatchObject({ gap: 6, paddingStart: 4, paddingEnd: 10 });
    expect(container.querySelector('[data-driver-avatar]')?.getAttribute('data-size')).toBe('18');
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

  it('lets a long native title shrink its name while retaining the avatar and grade', () => {
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
    const gradeStyle = JSON.parse(getByText('V5 6C').getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    const nameStyle = JSON.parse(getByText('Lightest Pair of Shorts').getAttribute('data-style') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(avatarStyle.flexShrink).toBe(0);
    expect(gradeStyle.flexShrink).toBe(0);
    expect(nameStyle).toMatchObject({ flexShrink: 1, minWidth: 0 });
    // A capped title ends the name in an ellipsis instead of clipping it.
    expect(getByText('Lightest Pair of Shorts').getAttribute('data-lines')).toBe('1');
    expect(getByText('Lightest Pair of Shorts').getAttribute('data-ellipsize')).toBe('tail');
    fireEvent.click(getByText('Lightest Pair of Shorts'));
    expect(spies.openWallPreview).toHaveBeenCalledOnce();
  });

  it.each([
    // A 320pt frame (Display Zoom, iPad Slide Over) beside five bar slots.
    [58, true],
    [99, true],
    // 375pt and up keep the face.
    [100, false],
    [113, false],
    [undefined, false],
  ])('drops the avatar, never the grade, when the title bound is %s (compact: %s)', (titleMaxWidth, compact) => {
    const { container, getByText } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <NativeTitleMaxWidthContext.Provider value={titleMaxWidth}>
          <WallStatusCapsule climb={makeClimb()} />
        </NativeTitleMaxWidthContext.Provider>
      </NativeHeaderActionContext.Provider>,
    );
    expect(container.querySelector('[data-driver-avatar]') == null).toBe(compact);
    expect(getByText('Wax On')).toBeTruthy();
    expect(getByText('V5 6C')).toBeTruthy();
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
    expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-radius')).toBe('16');
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

  it('renders the wall climb name and grade', () => {
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('Wax On')).not.toBeNull();
    expect(getByText('V5 6C')).not.toBeNull();
  });

  it('renders without crashing when the climb name is null (empty name, grade kept)', () => {
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb({ name: null })} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('V5 6C')).not.toBeNull();
  });

  it('omits the grade text when the climb grade is null (name and avatar kept)', () => {
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb({ grade: null })} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('Wax On')).not.toBeNull();
    expect(container.querySelector('[data-driver-avatar]')).not.toBeNull();
    expect(container.textContent).not.toContain('V5 6C');
  });

  it('leads with the sender avatar as decoration within the single preview button', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    const avatar = container.querySelector('[data-driver-avatar]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('data-uri')).toBe('https://example.com/casey.jpg');
    expect(avatar?.getAttribute('data-name')).toBe('Casey');
    expect(avatar?.getAttribute('data-size')).toBe('18');
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

  it.each([null, 'u-only'])('uses a person glyph without a photo or name (userId: %s)', (sentByUserId) => {
    const climb = makeClimb({ sentByDisplayName: null, sentByAvatarUrl: null, sentByUserId });
    const { container } = render(<WallStatusCapsule climb={climb} />);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
    expect(container.querySelector('[data-icon="profile.fill"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
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

  it('renders the Liquid Glass Pressable pill (not the Material band) on iOS', () => {
    const { container, queryByText } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(container.querySelector('[data-pressable-surface]')).not.toBeNull();
    // The glass pill carries the "lit" cue as the amber tint — no visible overline.
    expect(queryByText('mobile.boardPresence.stripOverline')).toBeNull();
  });

  it('shows no close button without onDismiss', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-label="mobile.boardPresence.stripDismiss"]')).toBeNull();
  });

  it('closes the pill through its own labelled button', () => {
    const onDismiss = vi.fn();
    const { container } = render(<WallStatusCapsule climb={makeClimb()} onDismiss={onDismiss} />);
    const close = container.querySelector('[data-label="mobile.boardPresence.stripDismiss"]');
    expect(close?.getAttribute('data-role')).toBe('button');
    expect(close?.querySelector('[data-icon="close"]')).not.toBeNull();
    fireEvent.click(close as Element);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  describe('Material variant (Android)', () => {
    beforeEach(() => {
      spies.variant = 'material';
    });

    it('puts the close button beside the band, outside the preview button', () => {
      const onDismiss = vi.fn();
      const { container } = render(<WallStatusCapsule climb={makeClimb()} onDismiss={onDismiss} />);
      const close = container.querySelector('[data-label="mobile.boardPresence.stripDismiss"]');
      expect(close).not.toBeNull();
      expect(close?.closest('[data-hint="mobile.boardPresence.stripA11yHint"]')).toBeNull();
      fireEvent.click(close as Element);
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(spies.openWallPreview).not.toHaveBeenCalled();
    });

    it('renders a Material status band via PressableSurface (native ripple), not the glass Pressable', () => {
      const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
      expect(container.querySelector('[data-pressable-surface]')).not.toBeNull();
      expect(getByText('Wax On')).not.toBeNull();
      expect(getByText('V5 6C')).not.toBeNull();
    });

    it('names the sender in the "On the wall" overline (no lightbulb)', () => {
      const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
      expect(container.querySelector('[data-driver-avatar]')).not.toBeNull();
      // The overline carries "lit + who" in words; the bottom queue bar owns the bulb.
      expect(getByText('mobile.boardPresence.stripOverlineWithSender:Casey')).not.toBeNull();
      expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
      // The person glyph belongs to the anonymous fallback, not a known sender.
      expect(container.querySelector('[data-icon="profile.fill"]')).toBeNull();
    });

    it('falls back to the bare overline + a neutral person glyph for an anonymous sender', () => {
      const climb = makeClimb({ sentByDisplayName: null, sentByAvatarUrl: null, sentByUserId: null });
      const { container, getByText } = render(<WallStatusCapsule climb={climb} />);
      // No sender to name — the overline drops the "· {sender}" suffix gracefully.
      expect(getByText('mobile.boardPresence.stripOverline')).not.toBeNull();
      expect(container.querySelector('[data-driver-avatar]')).toBeNull();
      expect(container.querySelector('[data-icon="profile.fill"]')).not.toBeNull();
      expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
    });

    it('keeps the band at its own 20dp face and subheadline text', () => {
      const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
      expect(container.querySelector('[data-driver-avatar]')?.getAttribute('data-size')).toBe('20');
      expect(getByText('Wax On').getAttribute('data-variant')).toBe('subheadline');
      expect(getByText('V5 6C').getAttribute('data-variant')).toBe('subheadline');
    });

    it('opens the read-only wall preview on tap', () => {
      const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
      fireEvent.click(container.querySelector('[data-pressable-surface]') as Element);
      expect(spies.openWallPreview).toHaveBeenCalledWith({ uuid: 'wall-1', _converted: true });
    });

    it('keeps the grade legible in the light scheme (still renders the grade text)', () => {
      spies.colorScheme = 'light';
      const { getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
      expect(getByText('V5 6C')).not.toBeNull();
    });

    it('exposes the same button role + sender-naming label as the glass skin', () => {
      const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
      const pressable = container.querySelector('[data-pressable-surface]');
      expect(pressable?.getAttribute('data-role')).toBe('button');
      expect(pressable?.getAttribute('data-label')).toContain('Wax On');
      expect(pressable?.getAttribute('data-label')).toContain('Casey');
    });
  });
});
