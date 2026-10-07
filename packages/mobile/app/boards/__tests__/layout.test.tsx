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
type ScreenOptions = {
  title?: string;
  headerLeft?: HeaderLeft;
  presentation?: string;
  autoHideHomeIndicator?: boolean;
};
type ScreenProps = {
  name: string;
  options?: ScreenOptions | ((props: { route: { params?: object } }) => ScreenOptions);
};

const routerMock = vi.hoisted(() => ({ back: vi.fn(), dismissTo: vi.fn(), canGoBack: vi.fn(() => true) }));
const platformMock = vi.hoisted(() => ({ OS: 'ios', isPad: false }));
const noteCloseTappedMock = vi.hoisted(() => vi.fn());
const screens = vi.hoisted(() => ({ byName: new Map<string, ScreenProps>() }));

vi.mock('expo-router', () => {
  const Stack = ({ children }: Children) => createElement('div', null, children);
  Stack.Screen = (props: ScreenProps) => {
    screens.byName.set(props.name, props);
    return null;
  };
  return { Stack, router: routerMock, useRouter: () => routerMock };
});
// The launch hold is covered by its own suite; here the screen renders as is.
vi.mock('../../../src/components/launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: <Screen,>(Screen: Screen) => Screen,
}));

vi.mock('react-native', () => ({
  Platform: platformMock,
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
  platformMock.OS = 'ios';
  platformMock.isPad = false;
  routerMock.canGoBack.mockReturnValue(true);
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

  // Climbs' "Find my board" opened it: an ordinary Close back to Climbs, but
  // noted, because a climber with no boards sees the "Where do you climb?"
  // block there and its skip names the X.
  it('is a noted plain close when Climbs opened it', () => {
    renderIndexHeaderLeft({ source: 'no_board' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
    expect(noteCloseTappedMock).toHaveBeenCalledTimes(1);
    expect(noteCloseTappedMock.mock.invocationCallOrder[0]).toBeLessThan(routerMock.back.mock.invocationCallOrder[0]);
  });

  it('falls back to the plain close when the params are missing or malformed', () => {
    renderIndexHeaderLeft(undefined);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    cleanup();
    renderIndexHeaderLeft({ source: 'onboarding', firstBoard: 1 });
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

// #5960: the live board sheet opens a reset as the first screen of this modal,
// where there is no back chevron. Edit holds is another flow's to change.
describe('boards stack header on the spray wizard opened as a reset', () => {
  it('gives the reset a close button that leaves through navigation', () => {
    vi.clearAllMocks();
    const { headerLeft } = optionsFor('spray/new', { resetOf: 'wall-uuid' });
    if (!headerLeft) throw new Error('spray/new has no headerLeft');
    render(createElement('div', null, headerLeft({ tintColor: '#000' })));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('titles the wizard as a reset only when it carries resetOf', () => {
    expect(optionsFor('spray/new', { resetOf: 'wall-uuid' }).title).toBe('Reset this wall');
    expect(optionsFor('spray/new').title).toBe('Add a spray wall');
  });
});

/** The options a screen declares, resolved the way the stack would. */
function optionsFor(name: string, params: object = {}): ScreenOptions {
  render(createElement(BoardsLayout));
  const declared = screens.byName.get(name)?.options;
  cleanup();
  if (!declared) throw new Error(`${name} options not captured`);
  return typeof declared === 'function' ? declared({ route: { params } }) : declared;
}

const SPRAY_SCREENS = ['spray/new', 'spray/holds'];

describe('the spray screens on iPad', () => {
  it.each(SPRAY_SCREENS)('%s covers the screen and fades the home indicator', (name) => {
    platformMock.isPad = true;
    const options = optionsFor(name);
    expect(options.presentation).toBe('fullScreenModal');
    expect(options.autoHideHomeIndicator).toBe(true);
  });

  // Full screen means no swipe down and, as a modal, no back chevron.
  it.each(['spray/new', 'spray/holds'])('%s has an X that goes back through the leave guard', (name) => {
    platformMock.isPad = true;
    const { headerLeft } = optionsFor(name);
    if (!headerLeft) throw new Error(`${name} has no headerLeft`);
    render(createElement('div', null, headerLeft({ tintColor: '#000' })));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // router.back is what the screens' own Back buttons call, so the
    // usePreventRemove guard sees the same action.
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
  });

  it('leaves a cold-linked screen for Climbs when there is nothing to go back to', () => {
    platformMock.isPad = true;
    routerMock.canGoBack.mockReturnValue(false);
    const { headerLeft } = optionsFor('spray/holds');
    if (!headerLeft) throw new Error('spray/holds has no headerLeft');
    render(createElement('div', null, headerLeft({ tintColor: '#000' })));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(routerMock.back).not.toHaveBeenCalled();
  });
});

describe('the spray screens on a phone', () => {
  // Not even an undefined key: it would override the stack's screenOptions.
  it.each([
    ['iOS', 'ios'],
    ['Android', 'android'],
  ])('add no presentation or home indicator keys on %s', (_label, os) => {
    platformMock.OS = os;
    for (const name of SPRAY_SCREENS) {
      const options = optionsFor(name);
      expect(Object.keys(options)).not.toContain('presentation');
      expect(Object.keys(options)).not.toContain('autoHideHomeIndicator');
    }
    // Edit holds keeps its back chevron on a phone; the iPad X is iPad only.
    expect(Object.keys(optionsFor('spray/holds'))).not.toContain('headerLeft');
  });

  // The #5960 X on a reset is not an iPad addition: every platform keeps it.
  it.each([
    ['iOS', 'ios'],
    ['Android', 'android'],
  ])('keeps the reset close button on %s', (_label, os) => {
    platformMock.OS = os;
    expect(Object.keys(optionsFor('spray/new', { resetOf: 'wall-uuid' }))).toEqual([
      'title',
      'headerBackButtonMenuEnabled',
      'headerLeft',
    ]);
  });

  // isPad is an iOS-only field; Android never reads it as an iPad.
  it('ignores a stray isPad on Android', () => {
    platformMock.OS = 'android';
    platformMock.isPad = true;
    expect(Object.keys(optionsFor('spray/holds'))).toEqual(['title', 'headerBackButtonMenuEnabled']);
  });
});
