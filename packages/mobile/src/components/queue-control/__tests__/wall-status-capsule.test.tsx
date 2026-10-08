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
  enterAnimation: vi.fn(() => ({})),
}));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'div',
      { 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))) },
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
vi.mock('../../../lib/board-presence/presence-climb', () => ({
  boardPresenceClimbToClimb: (c: { climbUuid: string }) => ({ uuid: c.climbUuid, _converted: true }),
}));
vi.mock('../../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ uri, name }: { uri?: string | null; name?: string | null }) =>
    createElement('span', { 'data-driver-avatar': 'true', 'data-uri': uri ?? '', 'data-name': name ?? '' }),
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
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
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
  }: {
    children?: ReactNode;
    onPress?: () => void;
    feedback?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
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
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));

import { WallStatusCapsule } from '../WallStatusCapsule';
import { NativeHeaderActionContext } from '../../chrome/native-header-action-context';

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
  });

  it('keeps the climb name intrinsic and shrinkable inside the native header', () => {
    const { container, getByText } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={makeClimb()} />
      </NativeHeaderActionContext.Provider>,
    );
    const nameViewer = container.querySelector('[data-label-viewer]');
    const nameStyle = JSON.parse(nameViewer?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    const capsuleStyle = JSON.parse(container.firstElementChild?.getAttribute('data-style') ?? '{}') as Record<
      string,
      unknown
    >;

    expect(getByText('Wax On')).toBeTruthy();
    expect(getByText('V5 6C')).toBeTruthy();
    expect(nameStyle).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(nameStyle.flex).toBeUndefined();
    expect(capsuleStyle).toMatchObject({ height: 44, borderRadius: 22 });
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-feedback')).toBe('none');
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(spies.enterAnimation).not.toHaveBeenCalled();
  });

  it('retains its native title view while the wall climb changes and opens the latest preview once', () => {
    const { container, rerender } = render(
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={makeClimb()} />
      </NativeHeaderActionContext.Provider>,
    );
    const originalTitleView = container.firstElementChild;
    rerender(
      <NativeHeaderActionContext.Provider value={true}>
        <WallStatusCapsule climb={makeClimb({ climbUuid: 'wall-2', name: 'The next long climb on the wall' })} />
      </NativeHeaderActionContext.Provider>,
    );

    expect(container.firstElementChild).toBe(originalTitleView);
    expect(container.textContent).toContain('The next long climb on the wall');
    fireEvent.click(container.querySelector('[data-pressable]')!);
    expect(spies.openWallPreview).toHaveBeenCalledOnce();
    expect(spies.openWallPreview).toHaveBeenCalledWith({ uuid: 'wall-2', _converted: true });
    expect(spies.enterAnimation).not.toHaveBeenCalled();
  });

  it('preserves the floating capsule entering animation outside a native header', () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);

    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(container.querySelector('[data-pressable]')?.getAttribute('data-feedback')).toBe('scale');
    expect(spies.enterAnimation).toHaveBeenCalledWith(180);
  });

  it('renders without the entering animation when Reduce Motion is on', () => {
    spies.reduceMotion = true;
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb()} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('Wax On')).not.toBeNull();
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

  it('omits the grade text when the climb grade is null (name + avatar kept)', () => {
    const { container, getByText } = render(<WallStatusCapsule climb={makeClimb({ grade: null })} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(getByText('Wax On')).not.toBeNull();
    expect(container.querySelector('[data-driver-avatar]')).not.toBeNull();
  });

  it("leads with the sender's avatar when there is a sender", () => {
    const { container } = render(<WallStatusCapsule climb={makeClimb()} />);
    const avatar = container.querySelector('[data-driver-avatar]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('data-uri')).toBe('https://example.com/casey.jpg');
    expect(avatar?.getAttribute('data-name')).toBe('Casey');
    // No lightbulb / person-glyph fallback when a sender is present.
    expect(container.querySelector('[data-icon="profile.fill"]')).toBeNull();
  });

  it('falls back to an amber person glyph (never a lightbulb) for a fully anonymous sender', () => {
    const climb = makeClimb({ sentByDisplayName: null, sentByAvatarUrl: null, sentByUserId: null });
    const { container } = render(<WallStatusCapsule climb={climb} />);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
    expect(container.querySelector('[data-icon="profile.fill"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
  });

  it('shows the person glyph for a userId-only sender (no photo, no display name)', () => {
    // A known id but nothing renderable as a face/monogram — the person glyph is
    // the correct fallback (and the avatar stays inert regardless of userId).
    const climb = makeClimb({ sentByDisplayName: null, sentByAvatarUrl: null, sentByUserId: 'u-x' });
    const { container } = render(<WallStatusCapsule climb={climb} />);
    expect(container.querySelector('[data-driver-avatar]')).toBeNull();
    expect(container.querySelector('[data-icon="profile.fill"]')).not.toBeNull();
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

  describe('Material variant (Android)', () => {
    beforeEach(() => {
      spies.variant = 'material';
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
