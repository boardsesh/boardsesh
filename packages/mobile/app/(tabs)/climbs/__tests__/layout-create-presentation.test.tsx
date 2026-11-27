// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabRouter, type TabNavigationState } from 'expo-router/build/react-navigation/routers/TabRouter';
import { StackRouter, type StackNavigationState } from 'expo-router/build/react-navigation/routers/StackRouter';
import type { RouteNode } from 'expo-router/build/Route';
import { createInitialState } from 'expo-router/build/react-navigation/core/createInitialState';
import type { ParamListBase } from 'expo-router/build/react-navigation/routers/types';
import { ROOT_CHAIN } from 'expo-router/build/react-navigation/routers/stateKeys';
import { resolveNavigationDestination } from 'expo-router/build/global-state/resolveNavigationDestination';
import { indexNavigationTree, reduceNavigationTree } from 'expo-router/build/global-state/reduceNavigationTree';
import type { RouterRegistryEntry } from 'expo-router/build/global-state/routerRegistry';

// How New climb is presented. A focused, full-height modal task (HIG
// "Modality"; M3 full-screen dialog on Android), never a drawer over the list
// and never fullScreenModal (docs/mobile/mobile-sheets-vs-routes.md, rule 2). Swipe to
// dismiss stays off because painting and pinching the board are drags (rule 3).

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android', isPad: false }));
const screens = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../../../../src/components/navigation/NativeTabletContent', () => ({
  NativeTabletContent: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('../../../../src/hooks/use-native-root-header', () => ({ useNativeRootHeader: () => false }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.OS;
    },
    get isPad() {
      return platform.isPad;
    },
  },
}));
vi.mock('expo-router', () => {
  const Stack = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  Stack.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) => {
    screens.set(name, options ?? {});
    return null;
  };
  return { Stack };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../../src/hooks/use-pop-to-top-on-tab-blur', () => ({ usePopToTopOnTabBlur: () => undefined }));
vi.mock('../../../../src/components/navigation/NativeTabContentInsetProbe', () => ({
  NativeTabContentInsetProbe: () => null,
}));
vi.mock('../../../../src/providers/board-art-visibility-provider', () => ({
  BoardArtVisibilityProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#221A33' } }),
}));

import ClimbsLayout, { unstable_settings } from '../_layout';

function createOptions() {
  render(createElement(ClimbsLayout));
  const options = screens.get('create');
  expect(options, 'the create screen is declared').toBeTruthy();
  return options ?? {};
}

beforeEach(() => {
  screens.clear();
  platform.OS = 'ios';
  platform.isPad = false;
});
afterEach(cleanup);

// Exercise the installed SDK 58 resolver, tree reducer and routers, as the
// drawer navigation suite does. Home is mounted; Climbs has no state/registry
// entry until its first cross-tab push. The real layout supplies its anchor.
function createClimbsNavigation() {
  const tabRouter = TabRouter({ initialRouteName: 'home' });
  const tabConfig = { routeNames: ['home', 'climbs'], routeGetIdList: {} };
  const climbsRouter = StackRouter({ initialRouteName: unstable_settings.anchor });
  const climbsConfig = {
    routeNames: ['index', 'setter/[username]', 'create', '[climbUuid]', 'holds'],
    routeGetIdList: {},
  };
  let tabState: TabNavigationState<ParamListBase> = {
    ...createInitialState({ ...tabConfig, initialRouteName: 'home', parentChain: ROOT_CHAIN }),
    type: 'tab',
  };
  const node = (route: string, children: RouteNode[] = []): RouteNode => ({
    type: children.length > 0 ? 'layout' : 'route',
    route,
    contextKey: `${route || 'root'}/${children.length > 0 ? '_layout' : 'index'}.tsx`,
    dynamic: null,
    children,
    loadRoute: () => ({}),
  });
  const climbsNode = node(
    'climbs',
    climbsConfig.routeNames.map((route) => node(route)),
  );
  climbsNode.loadRoute = () => ({ unstable_settings });
  const tabsNode = node('(tabs)', [node('home'), climbsNode]);
  const registry = new Map<string, RouterRegistryEntry>([
    [
      tabState.key,
      {
        routeNode: tabsNode,
        reduce: (state, action) =>
          tabRouter.getStateForAction(
            state as TabNavigationState<ParamListBase>,
            action as Parameters<typeof tabRouter.getStateForAction>[1],
            tabConfig,
          ),
        shouldActionChangeFocus: tabRouter.shouldActionChangeFocus,
        getStateForRouteFocus: (state, key) =>
          tabRouter.getStateForRouteFocus(state as TabNavigationState<ParamListBase>, key),
      },
    ],
  ]);
  const climbsState = () =>
    tabState.routes.find((route) => route.name === 'climbs')?.state as StackNavigationState<ParamListBase> | undefined;
  const reduce = (action: Parameters<typeof reduceNavigationTree>[0]) => {
    const tree = indexNavigationTree(tabState);
    const origin = tree.nodes.get(action.target ?? tabState.key);
    expect(origin, 'the destination action targets a mounted navigator').toBeDefined();
    if (!origin) throw new Error('missing navigator for the destination action');
    const result = reduceNavigationTree(action, registry, { tree, origin });
    expect(result.handled).toBe(true);
    if (result.handled) tabState = result.nextState as TabNavigationState<ParamListBase>;
  };
  const push = (destination: string, params: Record<string, string> = {}) => {
    const action = resolveNavigationDestination({
      targetState: { routes: [{ name: 'climbs', state: { routes: [{ name: destination, params }] } }] },
      navigationState: tabState,
      routeNode: tabsNode,
      registry,
      action: { type: 'PUSH', payload: {} },
      withAnchor: true,
    });
    reduce(action);
    const mountedClimbs = climbsState();
    expect(mountedClimbs, 'the push mounts Climbs').toBeDefined();
    if (!mountedClimbs) throw new Error('Climbs did not mount');
    registry.set(mountedClimbs.key, {
      routeNode: climbsNode,
      reduce: (state, nextAction) =>
        climbsRouter.getStateForAction(
          state as StackNavigationState<ParamListBase>,
          nextAction as Parameters<typeof climbsRouter.getStateForAction>[1],
          climbsConfig,
        ),
      shouldActionChangeFocus: climbsRouter.shouldActionChangeFocus,
      getStateForRouteFocus: (state, key) =>
        climbsRouter.getStateForRouteFocus(state as StackNavigationState<ParamListBase>, key),
    });
  };
  const back = () => {
    const mountedClimbs = climbsState();
    if (!mountedClimbs) throw new Error('Back needs a mounted Climbs stack');
    reduce({ type: 'POP', payload: { count: 1 }, target: mountedClimbs.key });
  };
  return { push, back, climbsState, selectedTab: () => tabState.routes[tabState.index].name };
}

describe('the Climbs stack', () => {
  it.each(['setter/[username]', 'create', '[climbUuid]'])(
    'keeps the list below a cold %s destination and Back returns to it',
    (destination) => {
      const navigation = createClimbsNavigation();
      expect(navigation.selectedTab()).toBe('home');
      expect(navigation.climbsState()).toBeUndefined();
      const params = { username: 'Setter / One', climbUuid: 'climb-one', boardName: 'tension', angle: '40' };

      navigation.push(destination, params);

      expect(navigation.selectedTab()).toBe('climbs');
      expect(navigation.climbsState()?.routes.map((route) => route.name)).toEqual(['index', destination]);
      expect(navigation.climbsState()?.routes[1].params).toEqual(params);
      navigation.back();
      expect(navigation.selectedTab()).toBe('climbs');
      expect(navigation.climbsState()?.routes.map((route) => route.name)).toEqual(['index']);
      expect(navigation.climbsState()?.index).toBe(0);
    },
  );

  it('preserves an already mounted stack when an anchored push adds another destination', () => {
    const navigation = createClimbsNavigation();
    navigation.push('holds');
    const previousRoutes = navigation.climbsState()?.routes;

    navigation.push('setter/[username]', { username: 'Setter Two' });

    expect(navigation.climbsState()?.routes.slice(0, 2)).toEqual(previousRoutes);
    expect(navigation.climbsState()?.routes.map((route) => route.name)).toEqual([
      'index',
      'holds',
      'setter/[username]',
    ]);
    navigation.back();
    expect(navigation.climbsState()?.routes).toEqual(previousRoutes);
  });
});

describe('the New climb route', () => {
  it('is a headerless modal sheet on iOS, with swipe-down off so the board keeps its drags', () => {
    const options = createOptions();
    expect(options.presentation).toBe('modal');
    expect(options.gestureEnabled).toBe(false);
    expect(options.headerShown).toBe(false);
    // A pageSheet always slides up on iOS. No `animation` key at all, so
    // nothing overrides the platform's own.
    expect(options).not.toHaveProperty('animation');
  });

  it('lets iOS draw the modal presentation background', () => {
    expect(createOptions()).not.toHaveProperty('contentStyle');
  });

  it('slides up from the bottom on Android, as an M3 full-screen dialog', () => {
    platform.OS = 'android';
    const options = createOptions();
    expect(options.presentation).toBe('modal');
    expect(options.animation).toBe('slide_from_bottom');
    expect(options.contentStyle).toEqual({ backgroundColor: '#221A33' });
  });

  it('uses an iPad editing card, preserving the live native tab sidebar', () => {
    platform.isPad = true;
    const options = createOptions();
    expect(options.presentation).toBe('modal');
    expect(options.gestureEnabled).toBe(false);
  });

  it('is never a drawer over the list, nor a full-screen cover over the iPhone tab bar', () => {
    const { presentation } = createOptions();
    expect(presentation).not.toBe('transparentModal');
    expect(presentation).not.toBe('fullScreenModal');
  });
});
