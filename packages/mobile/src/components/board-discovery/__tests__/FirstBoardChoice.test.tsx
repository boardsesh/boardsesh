// @vitest-environment jsdom
//
// The first-board picker's body (#5654): the header a newcomer sees when the
// launch gate opens the picker for them, the three ways to a board, and what
// "At a gym" shows under itself. The copy is the en-US catalog itself, so a
// renamed or missing key fails here instead of rendering a raw key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import type { FirstBoardGymState } from '../../../lib/boards/first-board-gym-state';

type Children = { children?: ReactNode };
const settingsCtrl = vi.hoisted(() => ({ canOpen: true }));

vi.mock('react-native', () => ({
  View: ({ children, accessibilityLiveRegion }: Children & { accessibilityLiveRegion?: string }) =>
    createElement('div', { 'data-live': accessibilityLiveRegion }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// Resolves against the real en-US catalog, so the test reads the shipped words.
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

vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Card', () => ({
  Card: ({ children, onPress, accessibilityLabel }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666', tertiaryLabel: '#999' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/open-app-settings', () => ({ canOpenAppSettings: () => settingsCtrl.canOpen }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

const { FirstBoardChoice } = await import('../FirstBoardChoice');

const callbacks = {
  onGym: vi.fn(),
  onOwn: vi.fn(),
  onScan: vi.fn(),
  onFindGymOnMap: vi.fn(),
  onOpenSettings: vi.fn(),
  onRetryNearby: vi.fn(),
};

function renderChoice(gymState: FirstBoardGymState = 'idle') {
  return render(
    <FirstBoardChoice
      gymState={gymState}
      nearbyResults={createElement('div', { 'data-testid': 'nearby' }, 'Near you')}
      {...callbacks}
    />,
  );
}

describe('FirstBoardChoice', () => {
  beforeEach(() => {
    settingsCtrl.canOpen = true;
    for (const callback of Object.values(callbacks)) callback.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('asks where they climb, as a header, with the reason under it', () => {
    renderChoice();
    expect(screen.getByRole('heading').textContent).toBe('Where do you climb?');
    expect(
      screen.getByText(
        "Pick your board to load its climbs. When you're connected, tapping a climb lights it on the wall.",
      ),
    ).toBeTruthy();
  });

  it('offers the three ways to a board', () => {
    renderChoice();
    expect(screen.getByRole('button', { name: "At a gym. Pick your gym's board" })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'My own board. Set up the board you have at home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan for the board in front of me' })).toBeTruthy();
  });

  it('says up front what the scan cannot see', () => {
    renderChoice();
    expect(screen.getByText("MoonBoards and some Kilter boxes don't show up here yet.")).toBeTruthy();
  });

  it('hands each tap to its flow', () => {
    renderChoice();
    fireEvent.click(screen.getByRole('button', { name: "At a gym. Pick your gym's board" }));
    fireEvent.click(screen.getByRole('button', { name: 'My own board. Set up the board you have at home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan for the board in front of me' }));
    expect(callbacks.onGym).toHaveBeenCalledTimes(1);
    expect(callbacks.onOwn).toHaveBeenCalledTimes(1);
    expect(callbacks.onScan).toHaveBeenCalledTimes(1);
  });

  it('shows nothing under "At a gym" until it is tapped', () => {
    renderChoice('idle');
    expect(screen.queryByTestId('nearby')).toBeNull();
    expect(screen.queryByText('Find your gym on the map')).toBeNull();
  });

  it('says it is looking while location and the list load', () => {
    renderChoice('searching');
    expect(screen.getByText('Looking for boards near you…')).toBeTruthy();
    expect(screen.getByTestId('spinner')).toBeTruthy();
  });

  it('lists the boards nearby, with the map as a way out', () => {
    renderChoice('found');
    expect(screen.getByTestId('nearby')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Find your gym on the map' }));
    expect(callbacks.onFindGymOnMap).toHaveBeenCalledTimes(1);
  });

  it('says when nothing is within 20 km and points to the map', () => {
    renderChoice('none_nearby');
    expect(screen.getByText('Nothing within 20 km')).toBeTruthy();
    expect(screen.queryByTestId('nearby')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find your gym on the map' }));
    expect(callbacks.onFindGymOnMap).toHaveBeenCalledTimes(1);
  });

  // A failed lookup is not an empty one: a climber standing in a gym must not
  // be told there is nothing within 20 km because the gym wifi is dead.
  it('says the lookup failed, with a retry and the map', () => {
    renderChoice('nearby_error');
    expect(screen.getByText("Couldn't load boards near you")).toBeTruthy();
    expect(screen.queryByText('Nothing within 20 km')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(callbacks.onRetryNearby).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Find your gym on the map' }));
    expect(callbacks.onFindGymOnMap).toHaveBeenCalledTimes(1);
  });

  it('says location is off and links to Settings and the map', () => {
    renderChoice('location_off');
    expect(screen.getByText('Location is off')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Find your gym on the map' })).toBeTruthy();
  });

  // The Expo browser app cannot open the OS settings; the map still works there.
  it('drops Open Settings where the platform cannot open it', () => {
    settingsCtrl.canOpen = false;
    renderChoice('location_off');
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Find your gym on the map' })).toBeTruthy();
  });
});
