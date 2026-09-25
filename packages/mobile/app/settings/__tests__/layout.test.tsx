// @vitest-environment jsdom
//
// Where Settings lives. It used to be `(tabs)/profile/more` plus a dozen
// sub-pages registered in the You tab's stack, which made opening it part of that
// tab's history: after one visit, tapping You reopened Settings instead of the
// profile. These two layouts are the fix — Settings owns a root stack, and the
// You tab keeps only the screens that are genuinely the profile's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
type HeaderLeft = (props: { tintColor?: string }) => ReactNode;
type ScreenProps = { name: string; options?: { title?: string; headerShown?: boolean; headerLeft?: HeaderLeft } };

const screens = vi.hoisted(() => ({ names: [] as string[], options: new Map<string, unknown>() }));
const routerMock = vi.hoisted(() => ({ back: vi.fn(), canGoBack: vi.fn(() => true), replace: vi.fn() }));

vi.mock('expo-router', () => {
  const Stack = ({ children }: Children) => createElement('div', null, children);
  Stack.Screen = (props: ScreenProps) => {
    screens.names.push(props.name);
    screens.options.set(props.name, props.options);
    return null;
  };
  return { Stack, router: routerMock };
});
vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress: () => void; accessibilityLabel: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../src/hooks/use-pop-to-top-on-tab-blur', () => ({ usePopToTopOnTabBlur: () => undefined }));
vi.mock('../../../src/components/navigation/NativeTabContentInsetProbe', () => ({
  NativeTabContentInsetProbe: () => null,
}));
vi.mock('../../../src/providers/board-art-visibility-provider', () => ({
  BoardArtVisibilityProvider: ({ children }: Children) => createElement('div', null, children),
}));

const { default: SettingsLayout } = await import('../_layout');
const { default: ProfileLayout } = await import('../../(tabs)/profile/_layout');

function screenNames(layout: () => ReactNode): string[] {
  screens.names = [];
  screens.options.clear();
  render(createElement(layout));
  return screens.names;
}

// Every page a Settings row can reach inside its own stack. A page missing here
// is a row that pushes into a navigator that doesn't register it.
const SETTINGS_PAGES = [
  'index',
  'board-look/index',
  'board-look/custom',
  'board-look/accessibility',
  'storage',
  'edit',
  'integrations',
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

  it('leaves the You tab holding only profile screens', () => {
    // The regression guard: a settings page back in this list is the bug — the
    // You tab would carry it in its own history again.
    expect(screenNames(ProfileLayout)).toEqual(['index', 'session/[sessionId]', 'notifications']);
  });

  it('gives the first Settings screen a back button, since iOS draws none for it', () => {
    // Settings is the only screen in its own native stack, so iOS shows no back
    // chevron on it. Without this button the page was a dead end.
    screenNames(SettingsLayout);
    const options = screens.options.get('index') as ScreenProps['options'];
    expect(options?.headerLeft).toBeTypeOf('function');

    routerMock.canGoBack.mockReturnValueOnce(true);
    render(createElement('div', null, options?.headerLeft?.({ tintColor: '#000' })));
    fireEvent.click(screen.getByRole('button', { name: 'ariaLabels.back' }));
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('goes Home when Settings was opened with nothing underneath', () => {
    screenNames(SettingsLayout);
    const options = screens.options.get('index') as ScreenProps['options'];
    routerMock.canGoBack.mockReturnValueOnce(false);
    render(createElement('div', null, options?.headerLeft?.({ tintColor: '#000' })));
    fireEvent.click(screen.getByRole('button', { name: 'ariaLabels.back' }));
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/home');
  });
});
