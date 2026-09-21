// @vitest-environment jsdom
//
// The boards stack's header X (#5654). In first-board mode, the picker the launch
// gate opens by itself for a new account, the X reads "Not now" and lands on
// Climbs, whatever was underneath; everywhere else it is a plain close that goes
// back. The picker reports the skip when it unmounts, and the X notes itself on
// the way out so that report can tell it from a swipe down.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import commonCatalog from '@boardsesh/i18n/locales/en-US/common.json';

type Children = { children?: ReactNode };
type HeaderLeft = (props: { tintColor?: string }) => ReactNode;
type ScreenOptions = { title?: string; headerLeft?: HeaderLeft };
type ScreenProps = {
  name: string;
  options?: ScreenOptions | ((props: { route: { params?: object } }) => ScreenOptions);
};

const routerMock = vi.hoisted(() => ({ back: vi.fn(), dismissTo: vi.fn() }));
const noteCloseTappedMock = vi.hoisted(() => vi.fn());
const screens = vi.hoisted(() => ({ byName: new Map<string, ScreenProps>() }));

vi.mock('expo-router', () => {
  const Stack = ({ children }: Children) => createElement('div', null, children);
  Stack.Screen = (props: ScreenProps) => {
    screens.byName.set(props.name, props);
    return null;
  };
  return { Stack, router: routerMock };
});
vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

// Resolves against the real en-US catalogs, so the test reads the shipped words.
function lookup(catalog: unknown, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      catalog,
    );
  return typeof value === 'string' ? value : key;
}
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string) => lookup(namespace === 'boards' ? boardsCatalog : commonCatalog, key),
  }),
}));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../src/lib/onboarding/first-board-picker-analytics', () => ({
  noteFirstBoardCloseTapped: noteCloseTappedMock,
}));

const { default: BoardsLayout } = await import('../_layout');

/** Renders the picker's header X for the given route params. */
function renderIndexHeaderLeft(params: object | undefined) {
  render(createElement(BoardsLayout));
  const indexScreen = screens.byName.get('index');
  if (!indexScreen || typeof indexScreen.options !== 'function') throw new Error('index options not captured');
  const headerLeft = indexScreen.options({ route: { params } }).headerLeft;
  if (!headerLeft) throw new Error('index has no headerLeft');
  cleanup();
  render(createElement('div', null, headerLeft({ tintColor: '#000' })));
}

beforeEach(() => {
  vi.clearAllMocks();
  screens.byName.clear();
});

afterEach(() => {
  cleanup();
});

describe('the board picker header X', () => {
  it('reads "Not now" in first-board mode and lands on Climbs', () => {
    renderIndexHeaderLeft({ source: 'onboarding', firstBoard: '1' });

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  // The skip event fires when the picker unmounts; this note is how it knows the
  // X closed it rather than a swipe down or Android back.
  it('notes the tap before it leaves', () => {
    renderIndexHeaderLeft({ source: 'onboarding', firstBoard: '1' });

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(noteCloseTappedMock).toHaveBeenCalledTimes(1);
    expect(noteCloseTappedMock.mock.invocationCallOrder[0]).toBeLessThan(
      routerMock.dismissTo.mock.invocationCallOrder[0],
    );
  });

  it('is a plain close that goes back for every other picker', () => {
    renderIndexHeaderLeft({ source: 'onboarding' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
    expect(noteCloseTappedMock).not.toHaveBeenCalled();
  });

  it('falls back to the plain close when the params are missing or malformed', () => {
    renderIndexHeaderLeft(undefined);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    cleanup();
    renderIndexHeaderLeft({ source: 'onboarding', firstBoard: 1 });
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});
