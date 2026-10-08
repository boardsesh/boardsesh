// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { NativeStackNavigationOptions } from 'expo-router';

type HeaderProps = {
  title?: string;
  leftActions?: ReactNode;
  leftActionsStandalone?: boolean;
  rightActions?: ReactNode;
  rightItems?: NativeStackNavigationOptions['unstable_headerRightItems'];
  onHeightChange?: (height: number) => void;
};

const controls = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  nativeHeader: false,
  glassCapability: true,
  nativeProps: null as HeaderProps | null,
  fallbackProps: null as HeaderProps | null,
}));
const appbar = vi.hoisted(() => ({
  title: null as string | null,
  contentPress: null as (() => void) | null,
  contentAria: null as string | null,
  contentHint: null as string | null,
}));

vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => controls.nativeHeader }));
vi.mock('../../../hooks/use-glass-capability', () => ({ useGlassCapability: () => controls.glassCapability }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9', error: '#C81E1E' },
    systemColors: { label: '#000', secondaryLabel: '#888', secondaryBackground: '#111', separator: '#333' },
    radii: { button: 20 },
    variant: controls.variant,
  }),
}));
vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-appbar': 'true' }, children),
    Content: ({
      title,
      onPress,
      accessibilityLabel,
      accessibilityHint,
    }: {
      title?: string;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityHint?: string;
    }) => {
      appbar.title = title ?? null;
      appbar.contentPress = onPress ?? null;
      appbar.contentAria = accessibilityLabel ?? null;
      appbar.contentHint = accessibilityHint ?? null;
      return createElement('div', { 'data-appbar-title': title ?? '', onClick: onPress }, title);
    },
    Action: ({ accessibilityLabel, onPress }: { accessibilityLabel?: string; onPress?: () => void }) =>
      createElement('button', { 'data-action': accessibilityLabel, onClick: onPress }),
  },
}));
vi.mock('../../icon-map', () => ({
  iconMap: {
    'person.badge.plus': { ios: 'person.badge.plus', android: 'account-plus-outline' },
    edit: { ios: 'pencil', android: 'pencil-outline' },
  },
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../chrome', () => ({
  CollapsingLargeTitleHeader: (props: HeaderProps) => {
    controls.fallbackProps = props;
    return createElement('div', { 'data-fallback': 'true' }, props.leftActions, props.rightActions);
  },
  GlassActionToolbar: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GlassToolbarAction: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-action': accessibilityLabel }, children),
  TOP_ACTION_SIZE: 48,
}));
vi.mock('../../chrome/NativeRootHeader', () => ({
  NativeRootHeader: (props: HeaderProps) => {
    controls.nativeProps = props;
    return createElement(
      'div',
      { 'data-native': 'true' },
      props.leftActions,
      props.rightItems ? null : props.rightActions,
    );
  },
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-text-color': color }, children),
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
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-pressable': accessibilityLabel,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 } }));
vi.mock('../../user-drawer/UserAvatarToolbarAction', () => ({
  UserAvatarToolbarAction: ({ variant }: { variant: string }) =>
    createElement('button', { 'data-action': 'ariaLabels.userMenu', 'data-avatar-variant': variant }),
}));

import { RecordTopChrome } from '../RecordTopChrome';

function makeProps(overrides: Partial<Parameters<typeof RecordTopChrome>[0]> = {}) {
  return { title: 'Morning session', onHeightChange: vi.fn(), ...overrides };
}

function nativeItems() {
  return controls.nativeProps?.rightItems?.({ tintColor: '#000', canGoBack: false }) ?? [];
}

function exitSelector(exitVariant: 'end' | 'leave') {
  return `[data-pressable="${exitVariant === 'leave' ? 'queueBar.ariaLabels.leaveSession' : 'mobile.session.inEndSession'}"]`;
}

describe('RecordTopChrome', () => {
  beforeEach(() => {
    controls.variant = 'liquidGlass';
    controls.nativeHeader = false;
    controls.glassCapability = true;
    controls.nativeProps = null;
    controls.fallbackProps = null;
    appbar.title = null;
    appbar.contentPress = null;
    appbar.contentAria = null;
    appbar.contentHint = null;
  });

  it.each(['floating', 'native', 'material'] as const)(
    'keeps the %s toolbar limited to avatar, invite, rename and exit',
    (presentation) => {
      controls.nativeHeader = presentation === 'native';
      controls.variant = presentation === 'material' ? 'material' : 'liquidGlass';
      const onShare = vi.fn();
      const { container } = render(
        <RecordTopChrome {...makeProps({ onShare, onEditTitle: vi.fn(), onEndSession: vi.fn() })} />,
      );
      expect(container.querySelector('[data-action="ariaLabels.userMenu"]')).not.toBeNull();
      fireEvent.click(container.querySelector('[data-action="mobile.session.invite"]')!);
      expect(onShare).toHaveBeenCalledOnce();
      expect(
        container.querySelectorAll(
          '[data-icon="board"], [data-icon="boards"], [data-icon="lightbulb"], [data-icon="lightbulb.fill"], [data-icon="flag"]',
        ),
      ).toHaveLength(0);
      expect(controls.nativeProps ?? controls.fallbackProps ?? {}).not.toHaveProperty('onOpenBoardSwitcher');
    },
  );

  it('lets the native header own the contextual title and updates it as a session starts', () => {
    controls.nativeHeader = true;
    const onHeightChange = vi.fn();
    const { rerender } = render(<RecordTopChrome {...makeProps({ title: 'Start a session', onHeightChange })} />);
    expect(controls.nativeProps).toMatchObject({
      title: 'Start a session',
      leftActionsStandalone: true,
      onHeightChange,
    });
    expect(controls.fallbackProps).toBeNull();
    rerender(<RecordTopChrome {...makeProps({ title: 'Evening crew', onHeightChange, onShare: vi.fn() })} />);
    expect(controls.nativeProps).toMatchObject({ title: 'Evening crew', leftActionsStandalone: false });
  });

  it('leaves the floating title in scroll content and forwards supplementary height', () => {
    const onHeightChange = vi.fn();
    render(<RecordTopChrome {...makeProps({ onHeightChange, onEditTitle: vi.fn() })} />);
    expect(controls.nativeProps).toBeNull();
    expect(controls.fallbackProps?.onHeightChange).toBe(onHeightChange);
    expect(controls.fallbackProps?.title).toBeUndefined();
    expect(controls.fallbackProps?.rightActions).toBeUndefined();
  });

  it.each(['end', 'leave'] as const)(
    'uses native plain %s and pencil items with working actions on iOS 26',
    (exitVariant) => {
      controls.nativeHeader = true;
      const onEditTitle = vi.fn();
      const onEndSession = vi.fn();
      render(<RecordTopChrome {...makeProps({ onEditTitle, onEndSession, exitVariant })} />);
      const [editItem, exitItem] = nativeItems();
      expect(editItem).toMatchObject({ type: 'button', icon: { type: 'sfSymbol', name: 'pencil' }, variant: 'plain' });
      expect(exitItem).toMatchObject({
        type: 'button',
        label: exitVariant === 'leave' ? 'mobile.session.inLeave' : 'mobile.session.inStop',
        variant: 'plain',
        labelStyle: { fontWeight: '600' },
      });
      if (editItem?.type !== 'button' || exitItem?.type !== 'button') throw new Error('Expected native bar buttons');
      expect(exitItem.icon).toBeUndefined();
      expect(exitItem.tintColor).toBe(exitVariant === 'end' ? '#C81E1E' : undefined);
      editItem.onPress?.();
      exitItem.onPress?.();
      expect(onEditTitle).toHaveBeenCalledOnce();
      expect(onEndSession).toHaveBeenCalledOnce();
    },
  );

  it('uses custom plain text and a separate rename action on older iOS', () => {
    controls.nativeHeader = true;
    controls.glassCapability = false;
    const onEditTitle = vi.fn();
    const onEndSession = vi.fn();
    const { container } = render(<RecordTopChrome {...makeProps({ onEditTitle, onEndSession })} />);
    expect(controls.nativeProps?.rightItems).toBeUndefined();
    fireEvent.click(container.querySelector('[data-action="mobile.session.editTitleAria"]')!);
    fireEvent.click(container.querySelector(exitSelector('end'))!);
    expect(onEditTitle).toHaveBeenCalledOnce();
    expect(onEndSession).toHaveBeenCalledOnce();
    const exitStyle = JSON.parse(container.querySelector(exitSelector('end'))!.getAttribute('data-style')!) as Record<
      string,
      unknown
    >;
    expect(exitStyle).toMatchObject({ minHeight: 44, minWidth: 44 });
    expect(exitStyle.backgroundColor).toBeUndefined();
    expect(exitStyle.borderWidth).toBeUndefined();
    expect(exitStyle.borderRadius).toBeUndefined();
  });

  it('removes native rename and exit items when their handlers are absent', () => {
    controls.nativeHeader = true;
    const { rerender } = render(<RecordTopChrome {...makeProps({ onEditTitle: vi.fn(), onEndSession: vi.fn() })} />);
    expect(nativeItems()).toHaveLength(2);
    rerender(<RecordTopChrome {...makeProps()} />);
    expect(nativeItems()).toHaveLength(0);
    expect(controls.nativeProps?.rightActions).toBeUndefined();
  });

  it.each([
    ['liquidGlass', 'end'],
    ['liquidGlass', 'leave'],
    ['material', 'end'],
    ['material', 'leave'],
  ] as const)(
    'renders %s %s as tinted text without an exit icon and preserves label activation',
    (variant, exitVariant) => {
      controls.variant = variant;
      const onEndSession = vi.fn();
      const { container } = render(<RecordTopChrome {...makeProps({ onEndSession, exitVariant })} />);
      const exitButton = container.querySelector(exitSelector(exitVariant));
      expect(exitButton?.textContent).toBe(
        exitVariant === 'leave' ? 'mobile.session.inLeave' : 'mobile.session.inStop',
      );
      expect(exitButton?.querySelector('[data-icon]')).toBeNull();
      expect(exitButton?.querySelector('[data-text-color]')?.getAttribute('data-text-color')).toBe(
        exitVariant === 'leave' ? '#000' : '#C81E1E',
      );
      fireEvent.contextMenu(exitButton!.querySelector('[data-viewer-title]')!);
      expect(onEndSession).toHaveBeenCalledOnce();
    },
  );

  it('keeps one Material title and a working separate rename action', () => {
    controls.variant = 'material';
    const onEditTitle = vi.fn();
    const { container, rerender } = render(
      <RecordTopChrome {...makeProps({ title: 'Active session', onEditTitle })} />,
    );
    expect(container.querySelectorAll('[data-appbar-title]')).toHaveLength(1);
    expect(appbar.title).toBe('Active session');
    expect(appbar.contentAria).toBe('Active session');
    expect(appbar.contentHint).toBe('mobile.session.editTitleAria');
    fireEvent.click(container.querySelector('[data-action="mobile.session.editTitleAria"]')!);
    expect(onEditTitle).toHaveBeenCalledOnce();
    expect(controls.nativeProps).toBeNull();
    expect(controls.fallbackProps).toBeNull();
    rerender(<RecordTopChrome {...makeProps()} />);
    expect(appbar.contentPress).toBeNull();
    expect(appbar.contentHint).toBeNull();
    expect(container.querySelector('[data-action="mobile.session.editTitleAria"]')).toBeNull();
  });
});
