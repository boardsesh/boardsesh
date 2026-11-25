// @vitest-environment jsdom
//
// "See gyms near you": the shipped en-US copy, the one button for each
// permission state, the shared snooze behind "Not now", and the events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';

type Children = { children?: ReactNode };

const settingsCtrl = vi.hoisted(() => ({ canOpen: true, opened: vi.fn() }));
const appState = vi.hoisted(() => ({ listeners: new Set<(next: string) => void>() }));
const mockStorage = vi.hoisted(() => new Map<string, string>());
const trackMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  AppState: {
    addEventListener: (_type: string, listener: (next: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        );
      return typeof value === 'string' ? value : key;
    },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Card', () => ({ Card: ({ children }: Children) => createElement('section', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    variant,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    variant?: string;
    disabled?: boolean;
  }) => createElement('button', { type: 'button', onClick: onPress, 'data-variant': variant, disabled }, title),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666' } }),
}));
vi.mock('../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => settingsCtrl.canOpen,
  openAppSettings: async () => {
    settingsCtrl.opened();
    return true;
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

import { resetAllSettings } from '../../../settings/hooks';
import { LocationAskCard } from '../LocationAskCard';
import type { LocationPermission, LocationRequest, LocationRequestOptions } from '../../../lib/use-device-location';

const TITLE = 'See gyms near you';
const BODY = 'Sorts by distance. Search works without it.';

const handlers = {
  onAllow: vi.fn<LocationRequest>(),
  onRecheck: vi.fn<() => Promise<LocationPermission>>(),
};

/** A prompt answered at once, with a fix that follows straight after. */
async function answeredRequest(options?: LocationRequestOptions): Promise<LocationPermission> {
  options?.onAnswer?.('granted');
  return 'granted';
}

function renderCard(permission: LocationPermission, surface: 'board_picker' | 'gym_finder' = 'gym_finder') {
  return render(<LocationAskCard surface={surface} permission={permission} {...handlers} />);
}

function bringAppTo(next: string) {
  for (const listener of appState.listeners) listener(next);
}

beforeEach(() => {
  resetAllSettings();
  settingsCtrl.canOpen = true;
  settingsCtrl.opened.mockClear();
  appState.listeners.clear();
  trackMock.mockClear();
  handlers.onAllow.mockReset().mockImplementation(answeredRequest);
  handlers.onRecheck.mockReset().mockResolvedValue('granted');
});
afterEach(cleanup);

describe('LocationAskCard', () => {
  // The picker's Near you lists boards; the gym map lists gyms.
  it('names what location finds on each surface', () => {
    renderCard('ask', 'board_picker');
    expect(screen.getByText('See boards near you')).toBeTruthy();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  // The answer is reported when the prompt closes, not seconds later when the
  // fix lands, and a second tap while the prompt is up sends nothing.
  it('reports the answer before the fix, and takes one tap while the prompt is up', () => {
    let answerPrompt: ((permission: LocationPermission) => void) | undefined;
    handlers.onAllow.mockImplementation(
      (options) =>
        new Promise<LocationPermission>(() => {
          // The fix never lands in this test.
          answerPrompt = options?.onAnswer;
        }),
    );
    renderCard('ask');
    const allow = screen.getByRole('button', { name: 'Allow' });

    fireEvent.click(allow);
    expect(allow.hasAttribute('disabled')).toBe(true);
    fireEvent.click(allow);
    expect(handlers.onAllow).toHaveBeenCalledOnce();
    expect(trackMock).not.toHaveBeenCalledWith('Location Ask Answered', expect.anything());

    act(() => answerPrompt?.('blocked'));

    expect(trackMock.mock.calls.filter(([event]) => event === 'Location Ask Answered')).toHaveLength(1);
    expect(trackMock).toHaveBeenLastCalledWith('Location Ask Answered', {
      surface: 'gym_finder',
      answer: 'allow',
      permission: 'blocked',
    });
    expect(screen.getByRole('button', { name: 'Allow' }).hasAttribute('disabled')).toBe(false);
  });

  it('asks with the system prompt while it can still ask, and reports the answer', async () => {
    renderCard('ask');
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('Location Ask Shown', {
      surface: 'gym_finder',
      permission: 'ask',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(handlers.onAllow).toHaveBeenCalledOnce();
    expect(settingsCtrl.opened).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(trackMock).toHaveBeenLastCalledWith('Location Ask Answered', {
        surface: 'gym_finder',
        answer: 'allow',
        permission: 'granted',
      }),
    );
  });

  // iOS after one no, Android "Don't ask again": the prompt would be a dead tap.
  it('opens Settings once only Settings can turn it on, and reads again on the way back', async () => {
    handlers.onRecheck.mockResolvedValue('granted');
    renderCard('blocked', 'board_picker');

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(settingsCtrl.opened).toHaveBeenCalledOnce();
    expect(handlers.onAllow).not.toHaveBeenCalled();

    // Leaving for Settings is not coming back.
    act(() => bringAppTo('background'));
    expect(handlers.onRecheck).not.toHaveBeenCalled();

    act(() => bringAppTo('active'));
    expect(handlers.onRecheck).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(trackMock).toHaveBeenLastCalledWith('Location Ask Answered', {
        surface: 'board_picker',
        answer: 'open_settings',
        permission: 'granted',
      }),
    );

    // One trip, one read: later returns to the app are not answers.
    act(() => bringAppTo('active'));
    expect(handlers.onRecheck).toHaveBeenCalledOnce();
    expect(appState.listeners.size).toBe(0);
  });

  it('says where to turn it on, with only Not now, where Settings cannot be opened (a browser)', () => {
    settingsCtrl.canOpen = false;
    renderCard('blocked');
    expect(screen.getByText('Allow location for this site in your browser. Search works without it.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Not now']);
  });

  it.each(['granted', 'unknown'] as const)('stays hidden while the permission is %s', (permission) => {
    renderCard(permission);
    expect(screen.queryByTestId('location-ask-card')).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  // One no anywhere is a no everywhere: the other surface's card goes too.
  it('"Not now" hides it on every surface for 14 days', () => {
    render(
      <>
        <LocationAskCard surface="board_picker" permission="ask" {...handlers} />
        <LocationAskCard surface="gym_finder" permission="blocked" {...handlers} />
      </>,
    );
    expect(screen.getAllByTestId('location-ask-card')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Not now' })[0]);

    expect(screen.queryByTestId('location-ask-card')).toBeNull();
    expect(trackMock).toHaveBeenCalledWith('Location Ask Answered', {
      surface: 'board_picker',
      answer: 'not_now',
      permission: 'ask',
    });
    expect(handlers.onAllow).not.toHaveBeenCalled();

    // And on the next screen that opens.
    cleanup();
    trackMock.mockClear();
    renderCard('ask');
    expect(screen.queryByTestId('location-ask-card')).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('reports itself shown once, however often it renders', () => {
    const { rerender } = renderCard('ask');
    rerender(<LocationAskCard surface="gym_finder" permission="blocked" {...handlers} />);
    expect(trackMock).toHaveBeenCalledOnce();
  });
});
