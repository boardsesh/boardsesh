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
    t: (key: string, params?: Record<string, string>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        );
      if (typeof value !== 'string') return key;
      return value.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => params?.[name] ?? placeholder);
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
  onAddSprayWall: vi.fn(),
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
        'Pick your board to load its climbs. A tap opens a climb as a preview; Put on board lights it on the wall.',
      ),
    ).toBeTruthy();
  });

  // The board in front of them is the picker's In range slot, above this block,
  // so there is no scan link here any more.
  it('offers the three ways to a board, Spraywall included, and no scan link', () => {
    renderChoice();
    expect(screen.getByRole('button', { name: "At a gym. Pick your gym's board" })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'My own board. Set up the board you have at home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'My Spraywall. Photograph it and mark the holds' })).toBeTruthy();
    expect(screen.queryByText(/Scan for the board/)).toBeNull();
  });

  it('hands each tap to its flow', () => {
    renderChoice();
    fireEvent.click(screen.getByRole('button', { name: "At a gym. Pick your gym's board" }));
    fireEvent.click(screen.getByRole('button', { name: 'My own board. Set up the board you have at home' }));
    fireEvent.click(screen.getByRole('button', { name: 'My Spraywall. Photograph it and mark the holds' }));
    expect(callbacks.onGym).toHaveBeenCalledTimes(1);
    expect(callbacks.onOwn).toHaveBeenCalledTimes(1);
    expect(callbacks.onAddSprayWall).toHaveBeenCalledTimes(1);
  });

  // With the add-a-board wizard on, the cards are its step 1 answered inline:
  // its words, and the same three ways (At a gym still lists nearby boards here).
  it("uses the wizard's step 1 words with the wizard on", () => {
    render(
      <FirstBoardChoice
        gymState="idle"
        nearbyResults={createElement('div', { 'data-testid': 'nearby' }, 'Near you')}
        {...callbacks}
        wizardCopy
      />,
    );
    expect(screen.getByRole('button', { name: "At a gym. Pick your gym's board" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'At home. Your own wall or garage board' }));
    fireEvent.click(screen.getByRole('button', { name: 'A Spraywall. Photograph it and mark the holds' }));
    expect(callbacks.onOwn).toHaveBeenCalledTimes(1);
    expect(callbacks.onAddSprayWall).toHaveBeenCalledTimes(1);
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

  // The In range slot's "Use my location" narrows the search to one
  // type. "Nothing within 20 km" would then be false in a gym full of other
  // boards, so the line names the type and offers every board.
  it('names the type it found none of, and offers every board', () => {
    const onShowAllNearby = vi.fn();
    render(
      <FirstBoardChoice
        gymState="none_nearby"
        nearbyResults={null}
        {...callbacks}
        nearbyBoardType="moonboard"
        onShowAllNearby={onShowAllNearby}
      />,
    );
    expect(screen.getByText('No MoonBoards within 20 km')).toBeTruthy();
    expect(screen.queryByText('Nothing within 20 km')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(onShowAllNearby).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Find your gym on the map' }));
    expect(callbacks.onFindGymOnMap).toHaveBeenCalledTimes(1);
    cleanup();

    render(
      <FirstBoardChoice
        gymState="none_nearby"
        nearbyResults={null}
        {...callbacks}
        nearbyBoardType="tension"
        onShowAllNearby={onShowAllNearby}
      />,
    );
    expect(screen.getByText('No Tension boards within 20 km')).toBeTruthy();
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
