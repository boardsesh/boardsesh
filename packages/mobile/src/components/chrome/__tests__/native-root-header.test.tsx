// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router';

const controls = vi.hoisted(() => ({
  glassCapability: true,
  // Whether the device and the climber's accessibility settings let the controls
  // under the bar float (iOS 26 glass, Reduce Transparency and Increase Contrast
  // off). use-floating-header-controls.test.ts covers how that is decided.
  canFloat: false,
  headerHeight: 148,
  frameWidth: 390,
  horizontalInsets: { left: 0, right: 0 },
  measuredControlsHeight: 36,
  focusedSegments: ['(tabs)', 'home'] as string[],
  options: [] as NativeStackNavigationOptions[],
  openUserDrawer: vi.fn(),
}));

type MockViewProps = {
  children?: ReactNode;
  style?: unknown;
  testID?: string;
  pointerEvents?: string;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};

vi.mock('react-native', () => ({
  View: ({ children, style, testID, pointerEvents, onLayout }: MockViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-pointer-events': pointerEvents,
        'data-controls': testID === 'header-controls' ? 'true' : undefined,
        'data-measure-controls': onLayout ? 'true' : undefined,
        onClick: onLayout
          ? () => onLayout({ nativeEvent: { layout: { height: controls.measuredControlsHeight } } })
          : undefined,
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
vi.mock('expo-router/react-navigation', () => ({
  useHeaderHeight: () => controls.headerHeight,
  useFrameSize: (selector: (frame: { width: number; height: number }) => number) =>
    selector({ width: controls.frameWidth, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, ...controls.horizontalInsets }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: 'theme-label',
      separator: 'theme-separator',
      elevatedSurface: 'surface',
      background: 'theme-background',
    },
  }),
}));
vi.mock('../../../hooks/use-glass-capability', () => ({ useGlassCapability: () => controls.glassCapability }));
vi.mock('../../../hooks/use-floating-header-controls', () => ({
  useFloatingHeaderControls: () => controls.canFloat,
}));
// Guard against reintroducing a continuous blur behind native capsules.
vi.mock('../../ProgressiveBlur', () => ({
  ProgressiveBlur: () => createElement('div', { 'data-backdrop': 'true' }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({ shadows: { sm: {} }, spacing: { 1: 4, 2: 8 } }));
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
import { createScrollEdgeBackdrop, type ScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';
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
    controls.canFloat = false;
    controls.headerHeight = 148;
    controls.frameWidth = 390;
    controls.horizontalInsets = { left: 0, right: 0 };
    controls.measuredControlsHeight = 36;
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

  it.each([390, 320, 600])('bounds long title content to the %spt local header frame between actions', (frameWidth) => {
    controls.frameWidth = frameWidth;
    render(
      <NativeRootHeader
        centerContent={<button>Lightest Pair of Shorts V4 6B</button>}
        centerActionWidths={{ leading: 88, trailing: 44 }}
        onHeightChange={vi.fn()}
      />,
    );
    const headerTitle = lastOptions().headerTitle;
    if (typeof headerTitle !== 'function') throw new Error('Expected a native center renderer');
    const { getByRole } = render(headerTitle({ children: 'Climbs', tintColor: 'theme-label' }));
    const centerStyle = readStyle(getByRole('button').parentElement);
    // Raw action slots plus each side's gutter, native capsule outset and gap.
    const reservedLeading = 88 + 16 + 8 + 8;
    const reservedTrailing = 44 + 16 + 8 + 8;
    expect(centerStyle.maxWidth).toBe(frameWidth - reservedLeading - reservedTrailing);
    expect(Number(centerStyle.maxWidth) + reservedLeading + reservedTrailing).toBe(frameWidth);
    expect(centerStyle).toMatchObject({ minWidth: 0, flexShrink: 1 });
  });

  it('recomputes the title bound when its local stack changes size or action count', () => {
    const { rerender } = render(
      <NativeRootHeader
        centerContent={<span>Long title</span>}
        centerActionWidths={{ leading: 88, trailing: 44 }}
        onHeightChange={vi.fn()}
      />,
    );
    const centerWidth = () => {
      const headerTitle = lastOptions().headerTitle;
      if (typeof headerTitle !== 'function') throw new Error('Expected a native center renderer');
      const { getByText, unmount } = render(headerTitle({ children: 'Climbs', tintColor: 'theme-label' }));
      const width = readStyle(getByText('Long title').parentElement).maxWidth;
      unmount();
      return width;
    };
    expect(centerWidth()).toBe(194);
    controls.frameWidth = 600;
    controls.horizontalInsets = { left: 59, right: 59 };
    rerender(
      <NativeRootHeader
        centerContent={<span>Long title</span>}
        centerActionWidths={{ leading: 44, trailing: 88 }}
        onHeightChange={vi.fn()}
      />,
    );
    expect(centerWidth()).toBe(286);
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

  it('forwards native trailing items and clears them when custom actions return', () => {
    const onStop = vi.fn();
    const rightItems: NativeStackNavigationOptions['unstable_headerRightItems'] = () => [
      { type: 'button', label: 'Stop', variant: 'plain', onPress: onStop },
    ];
    const { rerender } = render(<NativeRootHeader rightItems={rightItems} onHeightChange={vi.fn()} />);
    expect(lastOptions().unstable_headerRightItems).toBe(rightItems);
    const [stopItem] = lastOptions().unstable_headerRightItems!({ tintColor: 'theme-label', canGoBack: false });
    if (stopItem?.type !== 'button') throw new Error('Expected a native Stop item');
    stopItem.onPress?.();
    expect(onStop).toHaveBeenCalledOnce();

    rerender(<NativeRootHeader rightActions={<span>Custom actions</span>} onHeightChange={vi.fn()} />);
    expect(lastOptions()).toHaveProperty('unstable_headerRightItems', undefined);
    const customActions = lastOptions().headerRight?.({ tintColor: 'theme-label', canGoBack: false });
    const { getByText } = render(customActions);
    expect(getByText('Custom actions')).toBeTruthy();
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
    fireEvent.click(container.querySelector('[data-measure-controls]')!);
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

  describe('supplementary controls under the bar', () => {
    type ControlsProps = { opaqueControls?: boolean; scrollEdge?: ScrollEdgeBackdrop; gradeRowVisible?: boolean };
    const header = ({ gradeRowVisible, ...headerProps }: ControlsProps, onHeightChange: (height: number) => void) => (
      <NativeRootHeader onHeightChange={onHeightChange} {...headerProps}>
        <span>Filter chips</span>
        {gradeRowVisible ? <button>Grade row</button> : null}
      </NativeRootHeader>
    );
    const renderControls = (props: ControlsProps = {}) => {
      const onHeightChange = vi.fn();
      const view = render(header(props, onHeightChange));
      const block = () => view.container.querySelector('[data-controls]');
      // The blur, and the animated frame that positions and fades it.
      const backdrop = () => view.container.querySelector('[data-backdrop]');
      const backdropFrame = () => view.container.querySelector('[data-backdrop-frame]');
      const update = (next: ControlsProps) => view.rerender(header(next, onHeightChange));
      return { ...view, onHeightChange, block, backdrop, backdropFrame, update };
    };
    it('measures disclosed controls while they are open and releases their space when closed', () => {
      controls.canFloat = true;
      const { block, update, onHeightChange, getByText, queryByText } = renderControls();
      fireEvent.click(block()!.querySelector('[data-measure-controls]')!);
      expect(onHeightChange).toHaveBeenLastCalledWith(36);
      onHeightChange.mockClear();

      update({ gradeRowVisible: true });
      expect(block()!.contains(getByText('Grade row'))).toBe(true);
      expect(block()!.querySelector('[data-measure-controls]')!.contains(getByText('Grade row'))).toBe(true);
      controls.measuredControlsHeight = 88;
      fireEvent.click(block()!.querySelector('[data-measure-controls]')!);
      expect(onHeightChange).toHaveBeenLastCalledWith(88);

      // Real persistent-control resizing (rotation or text size) still measures.
      controls.measuredControlsHeight = 52;
      fireEvent.click(block()!.querySelector('[data-measure-controls]')!);
      expect(onHeightChange).toHaveBeenLastCalledWith(52);
      onHeightChange.mockClear();
      update({});
      expect(queryByText('Grade row')).toBeNull();
      controls.measuredControlsHeight = 36;
      fireEvent.click(block()!.querySelector('[data-measure-controls]')!);
      expect(onHeightChange).toHaveBeenLastCalledWith(36);
    });

    it('restores zero reserved height when supplementary controls are removed', () => {
      const onHeightChange = vi.fn();
      const { container, rerender } = render(
        <NativeRootHeader onHeightChange={onHeightChange}>
          <span>Search</span>
        </NativeRootHeader>,
      );
      fireEvent.click(container.querySelector('[data-measure-controls]')!);
      expect(onHeightChange).toHaveBeenLastCalledWith(36);
      rerender(<NativeRootHeader onHeightChange={onHeightChange} />);
      expect(onHeightChange).toHaveBeenLastCalledWith(0);
      expect(container.querySelector('[data-controls]')).toBeNull();
    });

    it('floats native controls without a continuous blur behind them', () => {
      controls.canFloat = true;
      const { block, backdrop, backdropFrame, getByText } = renderControls();
      expect(readStyle(block())).not.toHaveProperty('backgroundColor');
      expect(getByText('Filter chips')).toBeTruthy();
      expect(backdrop()).toBeNull();
      expect(backdropFrame()).toBeNull();
    });

    it.each([undefined, 'wired'] as const)('keeps filter and open grade controls without a blur (%s)', (wiring) => {
      controls.canFloat = true;
      const scrollEdge = wiring ? createScrollEdgeBackdrop() : undefined;
      const { block, backdrop, backdropFrame, update, getByText } = renderControls({ scrollEdge });
      update({ scrollEdge, gradeRowVisible: true });
      expect(block()!.contains(getByText('Grade row'))).toBe(true);
      expect(backdrop()).toBeNull();
      expect(backdropFrame()).toBeNull();
      expect(scrollEdge?.hasBackdrop() ?? false).toBe(false);
    });

    it('does not subscribe the floating controls to list scrolling', () => {
      controls.canFloat = true;
      const scrollEdge = createScrollEdgeBackdrop();
      const attachBackdrop = vi.spyOn(scrollEdge, 'attachBackdrop');
      const subscribe = vi.spyOn(scrollEdge, 'subscribe');
      const setTopOffset = vi.spyOn(scrollEdge, 'setTopOffset');
      const { block, backdrop, update } = renderControls({ scrollEdge });
      const initialBlock = block();
      act(() =>
        scrollEdge.listProps.onScroll({
          nativeEvent: { contentOffset: { x: 0, y: 400 } },
        } as NativeSyntheticEvent<NativeScrollEvent>),
      );
      controls.headerHeight = 100;
      update({ scrollEdge });
      expect(block()).toBe(initialBlock);
      expect(readStyle(block()).top).toBe(100);
      expect(backdrop()).toBeNull();
      expect(attachBackdrop).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(setTopOffset).not.toHaveBeenCalled();
      expect(scrollEdge.hasBackdrop()).toBe(false);
    });

    it.each([false, true])('preserves the opaque fallback (caller opts out: %s)', (opaqueControls) => {
      controls.canFloat = opaqueControls;
      const { block, backdrop } = renderControls({ opaqueControls });
      expect(readStyle(block()).backgroundColor).toBe('theme-background');
      expect(backdrop()).toBeNull();
    });

    it.each([true, false])('swallows touches in its bounds (floating: %s)', (canFloat) => {
      controls.canFloat = canFloat;
      const { block } = renderControls();
      expect(block()?.getAttribute('data-pointer-events')).toBe('auto');
    });

    it('reports the same reserved height floating as on an opaque band', () => {
      const measured = [true, false].map((canFloat) => {
        controls.canFloat = canFloat;
        const { block, onHeightChange, unmount } = renderControls();
        expect(readStyle(block()).top).toBe(148);
        fireEvent.click(block()!.querySelector('[data-measure-controls]')!);
        const reported = onHeightChange.mock.calls.at(-1);
        unmount();
        return reported;
      });
      expect(measured).toEqual([[36], [36]]);
    });

    it.each([100, 44, 0])('keeps the controls below the native bar at height %s without a blur', (headerHeight) => {
      controls.canFloat = true;
      const { block, backdrop, update } = renderControls();
      controls.headerHeight = headerHeight;
      update({});
      expect(readStyle(block()).top).toBe(headerHeight);
      expect(backdrop()).toBeNull();
    });

    it('draws no control block when the screen has no supplementary controls', () => {
      const { container } = render(<NativeRootHeader onHeightChange={vi.fn()} />);
      expect(container.querySelector('[data-controls]')).toBeNull();
      expect(container.querySelector('[data-backdrop]')).toBeNull();
    });
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
    fireEvent.click(container.querySelector('[data-measure-controls]')!);
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
