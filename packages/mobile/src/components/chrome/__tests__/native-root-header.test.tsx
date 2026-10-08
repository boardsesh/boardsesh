// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { NativeStackNavigationOptions } from 'expo-router';

const controls = vi.hoisted(() => ({
  glassCapability: true,
  headerHeight: 148,
  focusedSegments: ['(tabs)', 'home'] as string[],
  options: [] as NativeStackNavigationOptions[],
  openUserDrawer: vi.fn(),
}));

type MockViewProps = {
  children?: ReactNode;
  style?: unknown;
  testID?: string;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};

vi.mock('react-native', () => ({
  View: ({ children, style, testID, onLayout }: MockViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-controls': onLayout ? 'true' : undefined,
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 36 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({
  useSegments: () => controls.focusedSegments,
  Stack: {
    Screen: ({ options }: { options: NativeStackNavigationOptions }) => {
      controls.options.push(options);
      return null;
    },
  },
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => controls.headerHeight }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: 'theme-label', separator: 'theme-separator', elevatedSurface: 'surface' },
  }),
}));
vi.mock('../../../hooks/use-glass-capability', () => ({ useGlassCapability: () => controls.glassCapability }));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({ shadows: { sm: {} } }));
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ borderRadius }: { borderRadius: number }) =>
    createElement('div', { 'data-glass-radius': borderRadius }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    style,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    onPress: () => void;
    accessibilityLabel: string;
  }) =>
    createElement(
      'button',
      {
        'aria-label': accessibilityLabel,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock('react-native-paper', () => ({ Appbar: { Action: () => null } }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { displayName: 'Marco', avatarUrl: 'avatar.png' } }),
}));
vi.mock('../../user-drawer/UserDrawerProvider', () => ({
  useUserDrawer: () => ({ openUserDrawer: controls.openUserDrawer }),
}));
vi.mock('../../Avatar', () => ({
  Avatar: ({ size }: { size: number }) => createElement('span', { 'data-avatar-size': size }),
}));

import { NativeRootHeader } from '../NativeRootHeader';
import { GlassActionToolbar, GlassToolbarAction } from '../GlassActionToolbar';
import { UserAvatarToolbarAction } from '../../user-drawer/UserAvatarToolbarAction';

function lastOptions(): NativeStackNavigationOptions {
  return controls.options.at(-1)!;
}

function readStyle(element: Element | null): Record<string, unknown> {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

describe('NativeRootHeader', () => {
  beforeEach(() => {
    controls.glassCapability = true;
    controls.headerHeight = 148;
    controls.focusedSegments = ['(tabs)', 'home'];
    controls.options.length = 0;
    controls.openUserDrawer.mockClear();
  });

  it('preserves the route title with explicit label colors and no legacy blur', () => {
    render(<NativeRootHeader onHeightChange={vi.fn()} />);

    expect(lastOptions()).toMatchObject({
      headerShown: true,
      headerLargeTitle: true,
      headerTitleStyle: { color: 'theme-label' },
      headerLargeTitleStyle: { color: 'theme-label' },
    });
    expect(lastOptions()).not.toHaveProperty('title');
    expect(lastOptions().headerTitle).toBeUndefined();
    expect(lastOptions().headerBlurEffect).toBeUndefined();
  });

  it('retains the underlying route title when the climb drawer opens and closes', () => {
    controls.focusedSegments = ['(tabs)', 'climbs'];
    const routeOptions: NativeStackNavigationOptions = { title: 'Climbs' };
    const onHeightChange = vi.fn();
    const rootHeader = <NativeRootHeader centerContent={<span>Current climb</span>} onHeightChange={onHeightChange} />;
    const { rerender } = render(rootHeader);

    for (const focusedSegments of [['play'], ['(tabs)', 'climbs']]) {
      expect(lastOptions()).not.toHaveProperty('title');
      expect({ ...routeOptions, ...lastOptions() }.title).toBe('Climbs');
      expect(lastOptions().headerLargeTitle).toBe(false);
      controls.focusedSegments = focusedSegments;
      rerender(<NativeRootHeader centerContent={<span>Current climb</span>} onHeightChange={onHeightChange} />);
    }
    expect(lastOptions()).not.toHaveProperty('title');
    expect({ ...routeOptions, ...lastOptions() }.title).toBe('Climbs');
    expect(lastOptions().headerLargeTitle).toBe(false);

    rerender(<NativeRootHeader onHeightChange={onHeightChange} />);
    expect(lastOptions()).not.toHaveProperty('title');
    expect({ ...routeOptions, ...lastOptions() }.title).toBe('Climbs');
    expect(lastOptions().headerLargeTitle).toBe(true);
    expect(lastOptions().headerTitle).toBeUndefined();
  });

  it('keeps an explicit title override independent of the focused route', () => {
    controls.focusedSegments = ['play'];
    const { rerender } = render(<NativeRootHeader title="Climbs" onHeightChange={vi.fn()} />);
    expect(lastOptions().title).toBe('Climbs');

    controls.focusedSegments = ['(tabs)', 'climbs'];
    rerender(<NativeRootHeader title="" onHeightChange={vi.fn()} />);
    expect(lastOptions().title).toBe('');
  });

  it('keeps the existing blur on iOS before native glass support', () => {
    controls.glassCapability = false;
    render(<NativeRootHeader onHeightChange={vi.fn()} />);

    expect(lastOptions().headerBlurEffect).toBe('systemMaterial');
  });

  it('reports only supplementary controls and follows native header collapse', () => {
    const onHeightChange = vi.fn();
    const { container, rerender } = render(
      <NativeRootHeader onHeightChange={onHeightChange}>
        <span>Search</span>
      </NativeRootHeader>,
    );
    const supplementaryControls = container.querySelector('[data-controls]');
    expect(onHeightChange).toHaveBeenLastCalledWith(0);
    expect(readStyle(supplementaryControls).top).toBe(148);
    fireEvent.click(supplementaryControls!);
    expect(onHeightChange).toHaveBeenLastCalledWith(36);

    controls.headerHeight = 100;
    rerender(
      <NativeRootHeader onHeightChange={onHeightChange}>
        <span>Search</span>
      </NativeRootHeader>,
    );
    expect(readStyle(container.querySelector('[data-controls]')).top).toBe(100);
    expect(onHeightChange).toHaveBeenLastCalledWith(36);

    rerender(<NativeRootHeader onHeightChange={onHeightChange} />);
    expect(onHeightChange).toHaveBeenLastCalledWith(0);
  });

  it('keeps the interactive current climb in the native bar without another row', () => {
    const onHeightChange = vi.fn();
    const onOpenClimb = vi.fn();
    const climbName = 'A climb name that needs to truncate beside the header actions';
    const currentClimb = (
      <button aria-label={`On the wall: ${climbName}`} onClick={onOpenClimb}>
        {climbName}
      </button>
    );
    const { container, rerender } = render(
      <NativeRootHeader title="Climbs" centerContent={currentClimb} onHeightChange={onHeightChange} />,
    );
    expect(container.querySelector('[data-controls]')).toBeNull();
    expect(onHeightChange).toHaveBeenLastCalledWith(0);
    expect(lastOptions()).toMatchObject({ title: 'Climbs', headerLargeTitle: false });
    const headerTitle = lastOptions().headerTitle;
    if (typeof headerTitle !== 'function') throw new Error('Expected a native center renderer');
    const { container: headerContainer, getByRole } = render(
      headerTitle({ children: 'Climbs', tintColor: 'theme-label' }),
    );
    const currentClimbButton = getByRole('button', { name: `On the wall: ${climbName}` });
    expect(headerContainer.querySelectorAll('button')).toHaveLength(1);
    expect(readStyle(currentClimbButton.parentElement)).toMatchObject({
      height: 44,
      minWidth: 0,
      maxWidth: '100%',
      flexShrink: 1,
      alignItems: 'stretch',
    });
    fireEvent.click(currentClimbButton);
    expect(onOpenClimb).toHaveBeenCalledOnce();

    controls.headerHeight = 100;
    rerender(<NativeRootHeader title="Climbs" centerContent={currentClimb} onHeightChange={onHeightChange} />);
    expect(container.querySelector('[data-controls]')).toBeNull();
    expect(onHeightChange).toHaveBeenLastCalledWith(0);
    expect(lastOptions()).toMatchObject({ title: 'Climbs', headerLargeTitle: false });

    rerender(<NativeRootHeader title="Climbs" onHeightChange={onHeightChange} />);
    expect(lastOptions().headerTitle).toBeUndefined();
    expect(lastOptions()).toMatchObject({ title: 'Climbs', headerLargeTitle: true });
  });

  it('reserves supplementary search height without counting the centered climb', () => {
    const onHeightChange = vi.fn();
    const { container, getByText } = render(
      <NativeRootHeader title="Climbs" centerContent={<span>On the wall</span>} onHeightChange={onHeightChange}>
        <span>Search</span>
      </NativeRootHeader>,
    );

    expect(getByText('Search')).toBeTruthy();
    expect(container.textContent).not.toContain('On the wall');
    fireEvent.click(container.querySelector('[data-controls]')!);
    expect(onHeightChange).toHaveBeenLastCalledWith(36);
  });

  it('gives the standalone avatar exactly one circular glass background', () => {
    render(
      <NativeRootHeader
        onHeightChange={vi.fn()}
        leftActionsStandalone
        leftActions={
          <GlassActionToolbar actionCount={1} testID="avatar-toolbar">
            <UserAvatarToolbarAction variant="glass" />
          </GlassActionToolbar>
        }
      />,
    );
    const nativeItem = lastOptions().unstable_headerLeftItems?.({ tintColor: 'theme-label', canGoBack: false })[0];
    expect(nativeItem).toMatchObject({ type: 'custom', hidesSharedBackground: true });
    expect(lastOptions().headerLeft).toBeUndefined();
    if (nativeItem?.type !== 'custom') throw new Error('Expected a custom avatar item');
    const { container, getByRole, getByTestId } = render(nativeItem.element);

    expect(readStyle(getByTestId('avatar-toolbar'))).toMatchObject({ width: 44, height: 44, borderRadius: 22 });
    expect(container.querySelectorAll('[data-glass-radius="22"]')).toHaveLength(1);
    const avatarButton = getByRole('button', { name: 'ariaLabels.userMenu' });
    expect(readStyle(avatarButton)).toMatchObject({ width: 44, height: 44 });
    expect(readStyle(avatarButton.firstElementChild)).toMatchObject({ width: 44, height: 44, borderRightWidth: 0 });
    fireEvent.click(avatarButton);
    expect(controls.openUserDrawer).toHaveBeenCalledOnce();
  });

  it('keeps grouped native controls bare and shares 44-point slots with children', () => {
    render(
      <NativeRootHeader
        onHeightChange={vi.fn()}
        leftActions={
          <GlassActionToolbar actionCount={2} testID="grouped-toolbar">
            <UserAvatarToolbarAction variant="glass" />
            <GlassToolbarAction onPress={vi.fn()} accessibilityLabel="Create">
              +
            </GlassToolbarAction>
          </GlassActionToolbar>
        }
      />,
    );
    expect(lastOptions().unstable_headerLeftItems).toBeUndefined();
    const nativeGroup = lastOptions().headerLeft?.({ tintColor: 'theme-label', canGoBack: false });
    const { container, getAllByRole, getByTestId } = render(nativeGroup);

    expect(readStyle(getByTestId('grouped-toolbar'))).toMatchObject({ width: 88, height: 44 });
    expect(container.querySelector('[data-glass-radius]')).toBeNull();
    for (const button of getAllByRole('button')) {
      expect(readStyle(button)).toMatchObject({ width: 44, height: 44 });
    }
  });

  it('sizes shared floating toolbar children from an explicit slot without changing the default', () => {
    const { getByRole, getByTestId, rerender } = render(
      <GlassActionToolbar actionCount={1} actionSize={44} testID="sheet-toolbar">
        <GlassToolbarAction onPress={vi.fn()} accessibilityLabel="Save">
          Save
        </GlassToolbarAction>
      </GlassActionToolbar>,
    );
    expect(readStyle(getByTestId('sheet-toolbar'))).toMatchObject({ width: 44, height: 44 });
    expect(readStyle(getByRole('button'))).toMatchObject({ width: 44, height: 44 });

    rerender(
      <GlassActionToolbar actionCount={1} testID="sheet-toolbar">
        <GlassToolbarAction onPress={vi.fn()} accessibilityLabel="Save">
          Save
        </GlassToolbarAction>
      </GlassActionToolbar>,
    );
    expect(readStyle(getByTestId('sheet-toolbar'))).toMatchObject({ width: 48, height: 48 });
    expect(readStyle(getByRole('button'))).toMatchObject({ width: 48, height: 48 });
  });
});
