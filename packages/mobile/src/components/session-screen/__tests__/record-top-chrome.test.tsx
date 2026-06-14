// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, isValidElement, type ReactNode } from 'react';

type ChromeProps = {
  title?: string;
  canCreate?: boolean;
  onCreate?: () => void;
  createAccessibilityLabel?: string;
  onOpenBoardSwitcher?: () => void;
  boardPillAccessibilityHint?: string;
  compactBoardControl?: boolean;
  onHeightChange?: (height: number) => void;
  scrollY?: unknown;
  onPressTitle?: () => void;
  trailingAction?: ReactNode;
  trailingActionCount?: number;
  leadingAction?: ReactNode;
  leadingActionCount?: number;
  hideLight?: boolean;
  persistentCenterContent?: ReactNode;
  persistentTitle?: boolean;
};

// Captures every prop CollapsingTopChrome receives so the wrapper's forwarding +
// gating contract can be asserted directly.
const chrome = vi.hoisted(() => ({ props: null as ChromeProps | null }));
const ctrl = vi.hoisted(() => ({
  variant: 'glass' as 'glass' | 'material',
}));
// Captures the Material app bar's title + actions so the material branch can be
// asserted without a real Paper render.
const appbar = vi.hoisted(() => ({ title: null as string | null, actions: [] as string[] }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, pointerEvents, style }: { children?: ReactNode; pointerEvents?: string; style?: unknown }) =>
    createElement(
      'div',
      { 'data-pointer': pointerEvents ?? '', 'data-style': style == null ? '' : JSON.stringify(style) },
      children,
    ),
}));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// `ctrl.variant` drives which branch renders: 'glass' (default) exercises the
// CollapsingTopChrome forwarding contract; 'material' exercises the Paper app bar.
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9', error: '#C81E1E' },
    systemColors: { label: '#000', secondaryBackground: '#111', separator: '#333' },
    variant: ctrl.variant,
  }),
}));
vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-appbar': 'true' }, children),
    Content: ({ title }: { title?: ReactNode }) => {
      appbar.title = typeof title === 'string' ? title : null;
      return createElement('div', { 'data-appbar-title': typeof title === 'string' ? title : '' }, title);
    },
    Action: ({ accessibilityLabel }: { accessibilityLabel?: string }) => {
      if (accessibilityLabel) appbar.actions.push(accessibilityLabel);
      return createElement('div', { 'data-appbar-action': accessibilityLabel ?? '' });
    },
  },
}));
vi.mock('../../icon-map', () => ({
  iconMap: {
    settings: { ios: 'gearshape', android: 'cog-outline' },
    'person.badge.plus': { ios: 'person.badge.plus', android: 'account-plus-outline' },
    flag: { ios: 'flag', android: 'flag-outline' },
  },
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));
vi.mock('../../chrome', () => ({
  CollapsingTopChrome: (props: ChromeProps) => {
    chrome.props = props;
    return createElement(
      'div',
      { 'data-chrome': 'true' },
      props.persistentCenterContent,
      props.leadingAction,
      props.trailingAction,
    );
  },
  GlassToolbarAction: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-action': accessibilityLabel ?? '' }, children),
  TOP_ACTION_SIZE: 48,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-pressable': accessibilityLabel ?? '' }, children),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12 } }));
vi.mock('../../user-drawer/UserAvatarToolbarAction', () => ({
  UserAvatarToolbarAction: ({ variant }: { variant: 'glass' | 'material' }) => {
    if (variant === 'material') {
      appbar.actions.push('ariaLabels.userMenu');
    }
    return createElement('button', {
      'data-action': variant === 'glass' ? 'ariaLabels.userMenu' : undefined,
      'data-appbar-action': variant === 'material' ? 'ariaLabels.userMenu' : undefined,
      'data-avatar-variant': variant,
    });
  },
}));

import { RecordTopChrome } from '../RecordTopChrome';

const scrollY = { value: 0 } as unknown as Parameters<typeof RecordTopChrome>[0]['scrollY'];

function makeProps(over: Partial<Parameters<typeof RecordTopChrome>[0]> = {}) {
  return {
    title: 'Morning session',
    onOpenBoardSwitcher: vi.fn(),
    onHeightChange: vi.fn(),
    scrollY,
    onPressTitle: vi.fn(),
    ...over,
  };
}

describe('RecordTopChrome', () => {
  beforeEach(() => {
    chrome.props = null;
    ctrl.variant = 'glass';
    appbar.title = null;
    appbar.actions = [];
  });

  it('gates the create island off (canCreate=false)', () => {
    render(<RecordTopChrome {...makeProps()} />);
    expect(chrome.props?.canCreate).toBe(false);
  });

  it('forwards title / scrollY / onHeightChange / onPressTitle / onOpenBoardSwitcher', () => {
    const onHeightChange = vi.fn();
    const onPressTitle = vi.fn();
    const onOpenBoardSwitcher = vi.fn();
    render(
      <RecordTopChrome {...makeProps({ title: 'Evening sesh', onHeightChange, onPressTitle, onOpenBoardSwitcher })} />,
    );

    expect(chrome.props?.title).toBe('Evening sesh');
    expect(chrome.props?.scrollY).toBe(scrollY);
    expect(chrome.props?.onHeightChange).toBe(onHeightChange);
    expect(chrome.props?.onPressTitle).toBe(onPressTitle);
    expect(chrome.props?.onOpenBoardSwitcher).toBe(onOpenBoardSwitcher);
  });

  it('keeps the board selector in its compact toolbar form', () => {
    render(<RecordTopChrome {...makeProps()} />);
    expect(chrome.props?.compactBoardControl).toBe(true);
  });

  it('omits both leading and trailing actions and keeps the light before a session is live', () => {
    render(<RecordTopChrome {...makeProps()} />);
    expect(chrome.props?.leadingAction).toBeUndefined();
    expect(chrome.props?.trailingAction).toBeUndefined();
    expect(chrome.props?.leadingActionCount).toBe(0);
    expect(chrome.props?.trailingActionCount).toBe(0);
    expect(chrome.props?.hideLight).toBe(false);
  });

  it('docks invite/share as the LEADING (left) action, calling onShare', () => {
    const onShare = vi.fn();
    const { container } = render(<RecordTopChrome {...makeProps({ onShare })} />);

    expect(isValidElement(chrome.props?.leadingAction)).toBe(true);
    expect(chrome.props?.leadingActionCount).toBe(1);
    const shareButton = container.querySelector('[data-action="mobile.session.invite"]') as HTMLButtonElement | null;
    expect(shareButton).not.toBeNull();
    expect(shareButton?.querySelector('[data-icon="person.badge.plus"]')?.getAttribute('data-color')).toBe('#000');
    shareButton!.click();
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('docks session settings as a leading action, calling onOpenSettings', () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<RecordTopChrome {...makeProps({ onOpenSettings })} />);

    expect(isValidElement(chrome.props?.leadingAction)).toBe(true);
    expect(chrome.props?.leadingActionCount).toBe(1);
    const settingsButton = container.querySelector(
      '[data-action="mobile.session.settings"]',
    ) as HTMLButtonElement | null;
    expect(settingsButton).not.toBeNull();
    expect(settingsButton?.querySelector('[data-icon="settings"]')?.getAttribute('data-color')).toBe('#000');
    settingsButton!.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('docks settings + invite on the left and a labelled Stop pill on the right (no light) while a session is live', () => {
    const onShare = vi.fn();
    const onOpenSettings = vi.fn();
    const onEndSession = vi.fn();
    const { container } = render(<RecordTopChrome {...makeProps({ onShare, onOpenSettings, onEndSession })} />);

    // Settings + invite are the left slots; the Stop pill reserves two slots for
    // its label; the light is hidden.
    expect(chrome.props?.leadingActionCount).toBe(2);
    expect(chrome.props?.trailingActionCount).toBe(2);
    expect(chrome.props?.hideLight).toBe(true);

    const settingsButton = container.querySelector(
      '[data-action="mobile.session.settings"]',
    ) as HTMLButtonElement | null;
    expect(settingsButton).not.toBeNull();
    const shareButton = container.querySelector('[data-action="mobile.session.invite"]') as HTMLButtonElement | null;
    expect(shareButton).not.toBeNull();
    const stopButton = container.querySelector(
      '[data-pressable="mobile.session.inEndSession"]',
    ) as HTMLButtonElement | null;
    expect(stopButton).not.toBeNull();
    // The Stop control carries a visible "Stop" label, not just an icon.
    expect(stopButton?.textContent).toContain('mobile.session.inStop');
    settingsButton!.click();
    stopButton!.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onEndSession).toHaveBeenCalledTimes(1);
  });

  it('reserves two right slots for the Stop label (and hides the light) when only End is provided', () => {
    render(<RecordTopChrome {...makeProps({ onEndSession: vi.fn() })} />);
    expect(chrome.props?.trailingActionCount).toBe(2);
    expect(chrome.props?.leadingActionCount).toBe(0);
    expect(chrome.props?.hideLight).toBe(true);
  });

  it('keeps a persistent title center while a session is live', () => {
    render(<RecordTopChrome {...makeProps({ onEndSession: vi.fn() })} />);

    expect(chrome.props?.persistentCenterContent).toBeUndefined();
    expect(chrome.props?.persistentTitle).toBe(true);
    expect(chrome.props?.title).toBe('Morning session');
  });

  describe('material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it('renders the Paper app bar with the session title (no CollapsingTopChrome)', () => {
      const { container } = render(<RecordTopChrome {...makeProps({ title: 'Active session' })} />);
      expect(container.querySelector('[data-appbar="true"]')).not.toBeNull();
      expect(container.querySelector('[data-chrome="true"]')).toBeNull();
      expect(appbar.title).toBe('Active session');
    });

    it('shows the share app-bar action only while a session is live (onShare set)', () => {
      const { rerender } = render(<RecordTopChrome {...makeProps()} />);
      expect(appbar.actions).not.toContain('mobile.session.invite');

      appbar.actions = [];
      rerender(<RecordTopChrome {...makeProps({ onShare: vi.fn() })} />);
      expect(appbar.actions).toContain('mobile.session.invite');
    });

    it('shows the settings app-bar action only when provided', () => {
      const { rerender } = render(<RecordTopChrome {...makeProps()} />);
      expect(appbar.actions).not.toContain('mobile.session.settings');

      appbar.actions = [];
      rerender(<RecordTopChrome {...makeProps({ onOpenSettings: vi.fn() })} />);
      expect(appbar.actions).toContain('mobile.session.settings');
    });

    it('shows the End app-bar action only while a session is live (onEndSession set)', () => {
      const { rerender } = render(<RecordTopChrome {...makeProps()} />);
      expect(appbar.actions).not.toContain('mobile.session.inEndSession');

      appbar.actions = [];
      rerender(<RecordTopChrome {...makeProps({ onEndSession: vi.fn() })} />);
      expect(appbar.actions).toContain('mobile.session.inEndSession');
    });

    it('keeps the app-bar title and avatar during an active session', () => {
      const { container } = render(<RecordTopChrome {...makeProps({ onEndSession: vi.fn() })} />);

      expect(appbar.title).toBe('Morning session');
      expect(appbar.actions).toContain('ariaLabels.userMenu');
      expect(container.querySelector('[data-header-rep-timer="true"]')).toBeNull();
    });
  });
});
