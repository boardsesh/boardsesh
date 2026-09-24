// @vitest-environment jsdom
//
// Where Settings lives. It used to be `(tabs)/profile/more` plus a dozen
// sub-pages registered in the You tab's stack, which made opening it part of that
// tab's history: after one visit, tapping You reopened Settings instead of the
// profile. These two layouts are the fix — Settings owns a root stack, and the
// You tab keeps only the screens that are genuinely the profile's.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
type ScreenProps = { name: string; options?: { title?: string; headerShown?: boolean } };

const screens = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock('expo-router', () => {
  const Stack = ({ children }: Children) => createElement('div', null, children);
  Stack.Screen = (props: ScreenProps) => {
    screens.names.push(props.name);
    return null;
  };
  return { Stack };
});
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
  it('registers every settings page in its own root stack', () => {
    expect(screenNames(SettingsLayout)).toEqual(SETTINGS_PAGES);
  });

  it('leaves the You tab holding only profile screens', () => {
    // The regression guard: a settings page back in this list is the bug — the
    // You tab would carry it in its own history again.
    expect(screenNames(ProfileLayout)).toEqual(['index', 'session/[sessionId]', 'notifications']);
  });
});
