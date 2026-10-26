// @vitest-environment jsdom
//
// Where Settings lives. It used to be `(tabs)/profile/more` plus a dozen
// sub-pages registered in the You tab's stack, which made opening it part of that
// tab's history: after one visit, tapping You reopened Settings instead of the
// profile. These two layouts are the fix — Settings owns a root stack, and the
// You tab keeps only the screens that are genuinely the profile's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
type HeaderLeft = (props: { tintColor?: string }) => ReactNode;
type ScreenOptions = { title?: string; headerShown?: boolean; headerTintColor?: string; headerLeft?: HeaderLeft };
type ScreenProps = { name: string; options?: ScreenOptions };
// The slice of native-stack's `screenOptions({ navigation, route })` call the
// settings layout reads: which routes the stack holds, and which one this is.
type ScreenOptionsArgs = {
  navigation: { getState: () => { index: number; routes: { key: string; name: string }[] } };
  route: { key: string; name: string };
};
type ScreenOptionsFactory = (args: ScreenOptionsArgs) => ScreenOptions;

const screens = vi.hoisted(() => ({
  names: [] as string[],
  options: new Map<string, unknown>(),
  stackScreenOptions: undefined as unknown,
  /** How many times the Stack has rendered, to prove what does NOT re-render it. */
  stackRenders: 0,
}));
const routerMock = vi.hoisted(() => ({ back: vi.fn(), canGoBack: vi.fn(() => true), replace: vi.fn() }));
// A recognisable header style, so the tests can tell the shared stack options
// survive the per-screen back button being merged in.
const sharedStackOptions = vi.hoisted(() => ({ headerTintColor: '#123456' }));

vi.mock('expo-router', () => {
  const Stack = ({ children, screenOptions }: Children & { screenOptions?: unknown }) => {
    screens.stackRenders += 1;
    screens.stackScreenOptions = screenOptions;
    return createElement('div', null, children);
  };
  Stack.Screen = (props: ScreenProps) => {
    screens.names.push(props.name);
    screens.options.set(props.name, props.options);
    return null;
  };
  return { Stack, router: routerMock };
});
vi.mock('../../../src/components/navigation/NativeTabletContent', () => ({
  NativeTabletContent: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('../../../src/hooks/use-native-root-header', () => ({ useNativeRootHeader: () => false }));
vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress: () => void; accessibilityLabel: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
// The shared header back; its look is covered by header-action-buttons.test.
vi.mock('../../../src/components/HeaderActionButtons', () => ({
  HeaderLeadingButton: ({
    kind,
    onPress,
    accessibilityLabel,
  }: {
    kind: string;
    onPress: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel, 'data-kind': kind }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => sharedStackOptions }));
vi.mock('../../../src/hooks/use-pop-to-top-on-tab-blur', () => ({ usePopToTopOnTabBlur: () => undefined }));
// Downloads boards while Settings is open; its own suite covers it. Here it must
// be mounted once by the layout, and its state changes (the profile, My Boards
// and download state it reads) must not re-render the stack. The stand-in holds
// a state the test can bump, the way a refetch would.
const keepBoardsOffline = vi.hoisted(() => ({
  calls: 0,
  mounts: 0,
  bump: undefined as (() => void) | undefined,
}));
vi.mock('../../../src/offline/use-keep-boards-offline', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useKeepBoardsOffline: () => {
      keepBoardsOffline.calls += 1;
      const [, setRevision] = useState(0);
      keepBoardsOffline.bump = () => setRevision((revision) => revision + 1);
      useEffect(() => {
        keepBoardsOffline.mounts += 1;
      }, []);
    },
  };
});
vi.mock('../../../src/components/navigation/NativeTabContentInsetProbe', () => ({
  NativeTabContentInsetProbe: () => null,
}));
vi.mock('../../../src/providers/board-art-visibility-provider', () => ({
  BoardArtVisibilityProvider: ({ children }: Children) => createElement('div', null, children),
}));

const { default: SettingsLayout } = await import('../_layout');
const { settingsPageTitle, SETTINGS_ROOT_ROUTES } =
  await import('../../../src/components/settings/root/settings-pages');
const { default: ProfileLayout } = await import('../../(tabs)/profile/_layout');

function screenNames(layout: () => ReactNode): string[] {
  screens.names = [];
  screens.options.clear();
  screens.stackScreenOptions = undefined;
  screens.stackRenders = 0;
  keepBoardsOffline.calls = 0;
  keepBoardsOffline.mounts = 0;
  render(createElement(layout));
  return screens.names;
}

/**
 * Resolve the options native-stack would give `routeName` when the settings
 * stack holds `stack` (bottom first): the layout's `screenOptions` function,
 * overlaid with that screen's own `<Stack.Screen options>` the way React
 * Navigation merges them.
 */
function resolvedOptions(routeName: string, stack: string[]): ScreenOptions {
  screenNames(SettingsLayout);
  const factory = screens.stackScreenOptions as ScreenOptionsFactory;
  expect(factory).toBeTypeOf('function');
  const routes = stack.map((name) => ({ key: `${name}-key`, name }));
  const route = routes.find((candidate) => candidate.name === routeName);
  if (!route) throw new Error(`${routeName} is not in the stack`);
  const fromStack = factory({ navigation: { getState: () => ({ index: routes.length - 1, routes }) }, route });
  return { ...fromStack, ...(screens.options.get(routeName) as ScreenOptions | undefined) };
}

function pressHeaderBack(options: ScreenOptions) {
  render(createElement('div', null, options.headerLeft?.({ tintColor: '#000' })));
  fireEvent.click(screen.getByRole('button', { name: 'ariaLabels.back' }));
}

// Every page a Settings row can reach inside its own stack. A page missing here
// is a row that pushes into a navigator that doesn't register it.
const SETTINGS_PAGES = [
  'index',
  'general',
  'privacy',
  'privacy-people',
  'account',
  'integrations',
  'board-look/index',
  'board-look/custom',
  'board-look/accessibility',
  'climbs',
  'home',
  'timers',
  'early-access',
  'developer',
  'climb-list',
  'climb-view',
  'quick-filters',
  'storage',
  'privacy-access',
  'edit',
  'export',
  'watch-pair',
  'branch-switcher',
  'dev-servers',
  'feature-flags',
  'dev-offline-writes',
  'sentry-diagnostics',
  'outline-editor',
  'outline-canvas',
  'delete-account',
];

describe('the settings stack', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('registers every settings page in its own root stack', () => {
    expect(screenNames(SettingsLayout)).toEqual(SETTINGS_PAGES);
  });

  it('registers Settings as a headerless nested stack inside the You tab', () => {
    expect(screenNames(ProfileLayout)).toEqual(['index', 'session/[sessionId]', 'settings']);
    expect(screens.options.get('settings')).toMatchObject({ headerShown: false });
  });

  it('gives the first Settings screen a back button, since iOS draws none for it', () => {
    // Settings is the only screen in its own native stack, so iOS shows no back
    // chevron on it. Without this button the page was a dead end.
    const options = resolvedOptions('index', ['index']);
    expect(options.title).toBe('mobile.settings.title');
    expect(options.headerLeft).toBeTypeOf('function');

    routerMock.canGoBack.mockReturnValueOnce(true);
    pressHeaderBack(options);
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it.each(['climb-list', 'edit', 'integrations', 'privacy-access', 'climbs', 'privacy-people'])(
    'gives %s a back button when it is opened directly, with no Settings under it',
    (page) => {
      const options = resolvedOptions(page, [page]);
      expect(options.headerLeft).toBeTypeOf('function');
      routerMock.canGoBack.mockReturnValueOnce(true);
      pressHeaderBack(options);
      expect(routerMock.back).toHaveBeenCalledOnce();
    },
  );

  it('leaves a page pushed from Settings to the native back chevron', () => {
    const options = resolvedOptions('edit', ['index', 'edit']);
    expect(options.headerLeft).toBeUndefined();
    expect(options.title).toBe('profile.editAction');
    expect(options.headerTintColor).toBe(sharedStackOptions.headerTintColor);
  });

  it('keeps the back button on the Settings screen a push has covered', () => {
    // Options are worked out for every screen in the stack, not just the focused
    // one; the covered root must keep its button for the swipe back to it.
    const options = resolvedOptions('index', ['index', 'storage']);
    expect(options.headerLeft).toBeTypeOf('function');
    expect(options.headerTintColor).toBe(sharedStackOptions.headerTintColor);
  });

  it('sets the back button once, for the whole stack, rather than per screen', () => {
    screenNames(SettingsLayout);
    for (const page of SETTINGS_PAGES) {
      expect((screens.options.get(page) as ScreenOptions | undefined)?.headerLeft).toBeUndefined();
    }
  });

  it('titles every page on the Settings root with the label of the row that opens it', () => {
    // Both come from settingsPageTitle; the root model test checks the row half.
    const routeNames = {
      general: 'general',
      privacy: 'privacy',
      account: 'account',
      integrations: 'integrations',
      board: 'board-look/index',
      climbs: 'climbs',
      home: 'home',
      timers: 'timers',
      earlyAccess: 'early-access',
      developer: 'developer',
    } as const;
    screenNames(SettingsLayout);
    for (const [page, routeName] of Object.entries(routeNames)) {
      const title = (screens.options.get(routeName) as ScreenOptions | undefined)?.title;
      expect(title).toBe(settingsPageTitle(page as keyof typeof routeNames, (key: string) => key));
      expect(SETTINGS_ROOT_ROUTES[page as keyof typeof routeNames]).toBe(
        `/settings/${routeName.replace(/\/index$/, '')}`,
      );
    }
  });

  it('keeps boards offline from the layout, mounted exactly once, so it runs whichever page is open', () => {
    screenNames(SettingsLayout);
    expect(keepBoardsOffline.mounts).toBe(1);
    expect(keepBoardsOffline.calls).toBe(1);
  });

  it('re-renders only the keep-offline effect, not the stack, when its state changes', () => {
    // A My Boards refetch or a download progress tick lands inside the hook.
    // Called from the layout itself, that rebuilt the stack and every screen's
    // inline options on each one.
    screenNames(SettingsLayout);
    expect(screens.stackRenders).toBe(1);
    act(() => keepBoardsOffline.bump?.());
    expect(keepBoardsOffline.calls).toBe(2);
    expect(keepBoardsOffline.mounts).toBe(1);
    expect(screens.stackRenders).toBe(1);
  });

  it('goes Home when Settings was opened with nothing underneath', () => {
    const options = resolvedOptions('index', ['index']);
    routerMock.canGoBack.mockReturnValueOnce(false);
    pressHeaderBack(options);
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/home');
  });
});
