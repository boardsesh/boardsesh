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
  reduceMotion: false,
  // The backdrop's opacity (a Reanimated shared value) and every fade it started.
  backdropOpacity: undefined as { value: number } | undefined,
  backdropFades: [] as Array<{ to: number; duration: number }>,
  headerHeight: 148,
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
        'data-controls': onLayout ? 'true' : undefined,
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 36 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
// Reanimated, reduced to what the backdrop's fade needs: a shared value the test
// can read, and a record of each timing it was given.
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: {
      View: ({ children, style, pointerEvents }: MockViewProps) =>
        createElement(
          'div',
          {
            'data-backdrop-frame': 'true',
            'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
            'data-pointer-events': pointerEvents,
          },
          children,
        ),
    },
    useSharedValue: (initial: number) => {
      const sharedValue = useRef({ value: initial }).current;
      controls.backdropOpacity = sharedValue;
      return sharedValue;
    },
    useAnimatedStyle: (style: () => Record<string, unknown>) => style(),
    withTiming: (to: number, { duration }: { duration: number }) => {
      controls.backdropFades.push({ to, duration });
      return to;
    },
  };
});
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => controls.reduceMotion }));
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
// The blur behind floating controls. Stubbed to its props: the real one pulls in
// native blur and mask views, and progressive-blur.test.tsx covers what it draws.
vi.mock('../../ProgressiveBlur', () => ({
  ProgressiveBlur: ({
    style,
    layers,
    fadeLength,
    washOpacity,
    scrim,
  }: {
    style?: unknown;
    layers?: number;
    fadeLength?: number;
    washOpacity?: number;
    scrim?: boolean;
  }) =>
    createElement('div', {
      'data-backdrop': 'true',
      'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      'data-layers': layers,
      'data-fade-length': fadeLength,
      'data-wash-opacity': washOpacity,
      'data-scrim': String(scrim),
    }),
}));
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

import { CONTROLS_BACKDROP, NativeRootHeader } from '../NativeRootHeader';
import { createScrollEdgeBackdrop, type ScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';
import { timing } from '../../../theme/animations';
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
    controls.reduceMotion = false;
    controls.backdropOpacity = undefined;
    controls.backdropFades.length = 0;
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

  describe('supplementary controls under the bar', () => {
    type ControlsProps = { opaqueControls?: boolean; scrollEdge?: ScrollEdgeBackdrop };
    const header = (props: ControlsProps, onHeightChange: (height: number) => void) => (
      <NativeRootHeader onHeightChange={onHeightChange} {...props}>
        <span>Filter chips</span>
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
    // The screen's list, reporting to the store the header was handed.
    const scrollListTo = (scrollEdge: ScrollEdgeBackdrop, offsetY: number) =>
      act(() =>
        scrollEdge.listProps.onScroll({
          nativeEvent: { contentOffset: { x: 0, y: offsetY } },
        } as NativeSyntheticEvent<NativeScrollEvent>),
      );

    it('floats them over the list on iOS 26 glass: no painted band, a blur behind', () => {
      controls.canFloat = true;
      const { block, backdrop, backdropFrame, getByText } = renderControls();

      expect(readStyle(block())).not.toHaveProperty('backgroundColor');
      expect(getByText('Filter chips')).toBeTruthy();
      // One blur from the top of the screen (148 above the block, which sits under
      // the bar) to one fade-length below the block: full strength behind every
      // control, fading out over the rows under them.
      expect(readStyle(backdropFrame())).toMatchObject({
        position: 'absolute',
        top: -148,
        bottom: -CONTROLS_BACKDROP.fadeLength,
        left: 0,
        right: 0,
      });
      expect(backdropFrame()?.getAttribute('data-pointer-events')).toBe('none');
      expect(block()?.firstElementChild).toBe(backdropFrame());
      expect(backdropFrame()?.firstElementChild).toBe(backdrop());
      expect(backdrop()?.getAttribute('data-layers')).toBe(String(CONTROLS_BACKDROP.layers));
      expect(backdrop()?.getAttribute('data-fade-length')).toBe(String(CONTROLS_BACKDROP.fadeLength));
      expect(backdrop()?.getAttribute('data-wash-opacity')).toBe(String(CONTROLS_BACKDROP.washOpacity));
      // The dark status-bar scrim belongs to the old floating chrome's own band.
      expect(backdrop()?.getAttribute('data-scrim')).toBe('false');
    });

    // The system's scroll edge effect is there only while content is under the
    // bar. At rest the page behind the controls is the page, with no frost on it.
    describe('the blur follows the list', () => {
      beforeEach(() => {
        controls.canFloat = true;
      });

      it('is hidden while the list is at rest', () => {
        const { backdropFrame } = renderControls({ scrollEdge: createScrollEdgeBackdrop() });

        expect(readStyle(backdropFrame()).opacity).toBe(0);
        expect(controls.backdropOpacity?.value).toBe(0);
      });

      it('is shown from the first frame over a list already scrolled under', () => {
        const scrollEdge = createScrollEdgeBackdrop();
        scrollListTo(scrollEdge, 400);
        const { backdropFrame } = renderControls({ scrollEdge });

        expect(readStyle(backdropFrame()).opacity).toBe(1);
        expect(controls.backdropOpacity?.value).toBe(1);
      });

      it('fades in as rows pass under the controls and out as they leave', () => {
        const scrollEdge = createScrollEdgeBackdrop();
        renderControls({ scrollEdge });
        controls.backdropFades.length = 0;

        scrollListTo(scrollEdge, 60);
        expect(controls.backdropFades).toEqual([{ to: 1, duration: CONTROLS_BACKDROP.fadeDuration }]);
        expect(controls.backdropOpacity?.value).toBe(1);

        scrollListTo(scrollEdge, -148);
        expect(controls.backdropFades.at(-1)).toEqual({ to: 0, duration: CONTROLS_BACKDROP.fadeDuration });
        expect(controls.backdropOpacity?.value).toBe(0);
      });

      it('takes the length of its fade from the theme animation tokens', () => {
        expect(CONTROLS_BACKDROP.fadeDuration).toBe(timing.fast);
      });

      it('switches without a fade under Reduce Motion', () => {
        controls.reduceMotion = true;
        const scrollEdge = createScrollEdgeBackdrop();
        renderControls({ scrollEdge });

        scrollListTo(scrollEdge, 60);

        expect(controls.backdropFades).toEqual([]);
        expect(controls.backdropOpacity?.value).toBe(1);
      });

      // A screen that forgets to wire its list gets a frost at rest, which is
      // plain to see, and never bare controls over rows.
      it('stays on for a screen that does not report its list', () => {
        const { backdropFrame } = renderControls();

        expect(readStyle(backdropFrame()).opacity).toBe(1);
        expect(controls.backdropOpacity?.value).toBe(1);
      });

      it('keeps the block itself in place, hidden blur or not', () => {
        const { block, backdrop } = renderControls({ scrollEdge: createScrollEdgeBackdrop() });

        expect(backdrop()).not.toBeNull();
        expect(readStyle(block())).not.toHaveProperty('backgroundColor');
        expect(readStyle(block())).not.toHaveProperty('opacity');
      });

      // The list rests at minus the bar's height: that is where the block's
      // bottom edge meets the first row.
      it('tells the store where it drew the block, so rows are judged against it', () => {
        const scrollEdge = createScrollEdgeBackdrop();
        renderControls({ scrollEdge });

        scrollListTo(scrollEdge, -148);
        expect(scrollEdge.isScrolledUnder()).toBe(false);
        scrollListTo(scrollEdge, -120);
        expect(scrollEdge.isScrolledUnder()).toBe(true);
      });

      it('tells the store again when the bar changes height and the block moves', () => {
        const scrollEdge = createScrollEdgeBackdrop();
        const { update } = renderControls({ scrollEdge });
        scrollListTo(scrollEdge, -100);
        expect(scrollEdge.isScrolledUnder()).toBe(true);

        // The large title collapses: the block now sits right above that row.
        controls.headerHeight = 100;
        update({ scrollEdge });
        expect(scrollEdge.isScrolledUnder()).toBe(false);
        expect(controls.backdropOpacity?.value).toBe(0);
      });

      // The header holds the bar's options and the screen holds the list. A row
      // crossing under the controls must re-render neither.
      it('re-renders the blur alone when rows cross under the controls', () => {
        const scrollEdge = createScrollEdgeBackdrop();
        renderControls({ scrollEdge });
        const headerRenders = controls.options.length;

        scrollListTo(scrollEdge, 300);
        scrollListTo(scrollEdge, -148);
        scrollListTo(scrollEdge, 300);

        expect(controls.backdropOpacity?.value).toBe(1);
        expect(controls.options).toHaveLength(headerRenders);
      });
    });

    // The screen gives its list scroll listeners only while a blur is listening.
    describe('says whether a blur is listening', () => {
      it('is listening while the controls float', () => {
        controls.canFloat = true;
        const scrollEdge = createScrollEdgeBackdrop();
        const { unmount } = renderControls({ scrollEdge });
        expect(scrollEdge.hasBackdrop()).toBe(true);

        unmount();
        expect(scrollEdge.hasBackdrop()).toBe(false);
      });

      // Before iOS 26, Reduce Transparency, Increase Contrast.
      it('is not listening on the painted band', () => {
        const scrollEdge = createScrollEdgeBackdrop();
        renderControls({ scrollEdge });
        expect(scrollEdge.hasBackdrop()).toBe(false);
      });

      it('is not listening for a caller that opts out of floating', () => {
        controls.canFloat = true;
        const scrollEdge = createScrollEdgeBackdrop();
        renderControls({ scrollEdge, opaqueControls: true });
        expect(scrollEdge.hasBackdrop()).toBe(false);
      });

      it('is not listening on a screen with no controls', () => {
        controls.canFloat = true;
        const scrollEdge = createScrollEdgeBackdrop();
        render(<NativeRootHeader scrollEdge={scrollEdge} onHeightChange={vi.fn()} />);
        expect(scrollEdge.hasBackdrop()).toBe(false);
      });
    });

    // Material, Android, the web, iOS before 26, Reduce Transparency and Increase
    // Contrast all arrive here as "cannot float".
    it.each(['wired to a list', 'not wired'])(
      'keeps the painted band wherever the controls cannot float (%s)',
      (wiring) => {
        const scrollEdge = wiring === 'wired to a list' ? createScrollEdgeBackdrop() : undefined;
        if (scrollEdge) scrollListTo(scrollEdge, 400);
        const { block, backdrop, backdropFrame } = renderControls({ scrollEdge });

        expect(readStyle(block()).backgroundColor).toBe('theme-background');
        expect(backdrop()).toBeNull();
        expect(backdropFrame()).toBeNull();
      },
    );

    it.each(['wired to a list', 'not wired'])(
      'keeps the painted band for a caller that opts out, even on iOS 26 glass (%s)',
      (wiring) => {
        controls.canFloat = true;
        const scrollEdge = wiring === 'wired to a list' ? createScrollEdgeBackdrop() : undefined;
        if (scrollEdge) scrollListTo(scrollEdge, 400);
        const { block, backdrop, backdropFrame } = renderControls({ opaqueControls: true, scrollEdge });

        expect(readStyle(block()).backgroundColor).toBe('theme-background');
        expect(backdrop()).toBeNull();
        expect(backdropFrame()).toBeNull();
      },
    );

    it.each([true, false])('swallows touches in its bounds (floating: %s)', (canFloat) => {
      controls.canFloat = canFloat;
      const { block } = renderControls({ scrollEdge: createScrollEdgeBackdrop() });
      // Never box-none: a row smeared by the blur must not take a tap through the
      // gaps between the chips.
      expect(block()?.getAttribute('data-pointer-events')).toBe('auto');
    });

    it('reports the same height floating as on the band: the blur is not measured', () => {
      const measured = [true, false].map((canFloat) => {
        controls.canFloat = canFloat;
        const { block, onHeightChange, unmount } = renderControls();
        expect(readStyle(block()).top).toBe(148);
        fireEvent.click(block()!);
        const reported = onHeightChange.mock.calls.at(-1);
        unmount();
        return reported;
      });
      expect(measured).toEqual([[36], [36]]);
    });

    it('moves the blur with the block as the large title collapses', () => {
      controls.canFloat = true;
      const { block, backdropFrame, update } = renderControls();
      controls.headerHeight = 100;
      update({});

      expect(readStyle(block()).top).toBe(100);
      // Still starts at the top of the screen.
      expect(readStyle(backdropFrame()).top).toBe(-100);
    });

    it('draws no blur on a screen with no controls', () => {
      controls.canFloat = true;
      const { container } = render(<NativeRootHeader onHeightChange={vi.fn()} />);
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
