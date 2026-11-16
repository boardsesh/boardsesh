// @vitest-environment jsdom
//
// The board picker's In range slot, rendered for every content kind
// in-range-view.ts can produce: the copy (the shipped en-US catalog), the
// buttons and what each one calls, Open Settings dropping where the platform
// can't open it, and which states offer Scan again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import settingsCatalog from '@boardsesh/i18n/locales/en-US/settings.json';
import type { DiscoveryBoardItem } from '../BoardDiscoveryCardView';
import type { InRangeContent, UnnamedInRangeRow } from '../in-range-view';
import type { InRangeLocationHint } from '../InRangeSection';

type Children = { children?: ReactNode };
const settingsCtrl = vi.hoisted(() => ({ canOpen: true }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

const CATALOGS: Record<string, unknown> = { boards: boardsCatalog, settings: settingsCatalog };
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          CATALOGS[namespace],
        );
      if (typeof value !== 'string') return key;
      return value.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => String(params?.[name] ?? placeholder));
    },
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Card', () => ({ Card: ({ children }: Children) => createElement('section', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, loading }: { title: string; onPress: () => void; loading?: boolean }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-loading': loading ? 'yes' : 'no' }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress: () => void; accessibilityLabel?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      tertiaryBackground: '#eee',
      secondaryBackground: '#f5f5f5',
      separator: '#ccc',
    },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#fff' },
  }),
}));
vi.mock('../../../lib/open-app-settings', () => ({ canOpenAppSettings: () => settingsCtrl.canOpen }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32 },
  borderRadius: { md: 8, lg: 12, full: 9999 },
}));

const { InRangeSection } = await import('../InRangeSection');

const KILTER: DiscoveryBoardItem = {
  key: 'board:crux-kilter',
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  title: 'Crux Kilter',
  subtitle: 'Crux · 12 x 12',
};
const TENSION: DiscoveryBoardItem = { ...KILTER, key: 'board:crux-tension', title: 'Crux Tension' };
const MOONBOARD: UnnamedInRangeRow = {
  kind: 'moonboard',
  key: 'moonboard:moonboard',
  boardType: 'moonboard',
  rssi: -55,
  deviceId: 'MOON-BOX',
};
const BARE_TENSION: UnnamedInRangeRow = {
  kind: 'bare_name',
  key: 'bare_name:tension',
  boardType: 'tension',
  rssi: -60,
  deviceId: null,
};
const UNKNOWN_SETUP: UnnamedInRangeRow = {
  kind: 'unknown_setup',
  key: 'unknown_setup:kilter',
  boardType: 'kilter',
  rssi: -60,
};

const handlers = {
  onStart: vi.fn(),
  onOpenSettings: vi.fn(),
  onRetryLookup: vi.fn(),
  onPickBoard: vi.fn(),
  onUseMyLocation: vi.fn(),
  onSearchGyms: vi.fn(),
  onOwnBoard: vi.fn(),
};

function BoardArt({ item }: { item: DiscoveryBoardItem }) {
  return createElement('div', { 'data-art': item.key });
}

function renderSlot(
  content: InRangeContent<DiscoveryBoardItem>,
  { scanning = false, locationHint = null }: { scanning?: boolean; locationHint?: InRangeLocationHint | null } = {},
) {
  return render(
    <InRangeSection view={{ content, scanning }} BoardArt={BoardArt} locationHint={locationHint} {...handlers} />,
  );
}

function buttons(): string[] {
  return screen.queryAllByRole('button').map((button) => button.textContent ?? '');
}

beforeEach(() => {
  settingsCtrl.canOpen = true;
  for (const handler of Object.values(handlers)) handler.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('InRangeSection', () => {
  // Every state that is not about a board: one quiet line, no section title.
  it.each<{
    name: string;
    content: InRangeContent<DiscoveryBoardItem>;
    line: string | null;
    button: string | null;
    calls: keyof typeof handlers | null;
  }>([
    { name: 'nothing to show', content: { kind: 'none' }, line: null, button: null, calls: null },
    {
      name: 'Bluetooth refused for good',
      content: { kind: 'blocked_denied' },
      line: 'Allow Bluetooth in Settings to spot the board in front of you.',
      button: 'Open Settings',
      calls: 'onOpenSettings',
    },
    {
      name: 'Bluetooth off',
      content: { kind: 'blocked_off' },
      line: 'Turn on Bluetooth to spot the board in front of you.',
      button: 'Scan again',
      calls: 'onStart',
    },
    {
      name: 'Bluetooth unreachable, which may well be on',
      content: { kind: 'unreachable' },
      line: "Couldn't reach Bluetooth.",
      button: 'Scan again',
      calls: 'onStart',
    },
    {
      name: 'nothing heard, pre-empted or not',
      content: { kind: 'none_in_range' },
      line: 'No boards in range',
      button: 'Scan again',
      calls: 'onStart',
    },
  ])('$name: one quiet line', ({ content, line, button, calls }) => {
    const { container } = renderSlot(content);
    expect(screen.queryByText('In range')).toBeNull();
    if (line === null) {
      expect(container.textContent).toBe('');
      return;
    }
    expect(screen.getByText(line)).toBeTruthy();
    expect(buttons()).toEqual(button ? [button] : []);
    if (button && calls) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(handlers[calls]).toHaveBeenCalledOnce();
    }
  });

  it('drops Open Settings where the platform cannot open it, keeping the line', () => {
    settingsCtrl.canOpen = false;
    renderSlot({ kind: 'blocked_denied' });
    expect(screen.getByText('Allow Bluetooth in Settings to spot the board in front of you.')).toBeTruthy();
    expect(buttons()).toEqual([]);
  });

  // Android withholding the results: the fix replaces "No boards in range".
  it.each<{ hint: InRangeLocationHint['kind']; title: string; action: string }>([
    {
      hint: 'grant_location',
      title: 'Android needs Location to see boards',
      action: settingsCatalog.ble.locationHintGrant,
    },
    {
      hint: 'enable_location_services',
      title: 'Location is switched off',
      action: settingsCatalog.ble.locationServicesHintEnable,
    },
  ])('says Android hides the results ($hint) instead of "No boards in range"', ({ hint, title, action }) => {
    const onPress = vi.fn();
    renderSlot({ kind: 'none_in_range' }, { locationHint: { kind: hint, busy: true, onPress } });

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText('No boards in range')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scan again' })).toBeNull();
    const fix = screen.getByRole('button', { name: action });
    expect(fix.getAttribute('data-loading')).toBe('yes');
    fireEvent.click(fix);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('asks for Bluetooth with Continue, under the In range title', () => {
    renderSlot({ kind: 'permission_card' });
    expect(screen.getByRole('heading').textContent).toBe('In range');
    expect(screen.getByText("Spot the board you're at")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(handlers.onStart).toHaveBeenCalledOnce();
  });

  it('waits for a tap with the Scan card', () => {
    renderSlot({ kind: 'tap_to_scan' });
    expect(screen.getByText('Look for the board in front of you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(handlers.onStart).toHaveBeenCalledOnce();
  });

  it('holds its place while looking, with the spinner by the title and no button', () => {
    renderSlot({ kind: 'looking' }, { scanning: true });
    expect(screen.getByText('Looking for boards…')).toBeTruthy();
    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(buttons()).toEqual([]);
  });

  it('leads with the one board it can name, and Climb here picks it', () => {
    renderSlot({ kind: 'hero', board: KILTER, also: null });
    expect(screen.getByText('In front of you')).toBeTruthy();
    expect(screen.getByText('Crux Kilter')).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(buttons()).toEqual(['Climb here']);
    fireEvent.click(screen.getByRole('button', { name: 'Climb here' }));
    expect(handlers.onPickBoard).toHaveBeenCalledExactlyOnceWith(KILTER);
  });

  it('lists several named boards closest first, with the gym and a Closest pill, and no Climb here', () => {
    renderSlot({ kind: 'board_rows', boards: [KILTER, TENSION], gymName: 'Crux', also: null });
    expect(screen.getByText('Crux · 2 walls')).toBeTruthy();
    expect(screen.queryByText('In front of you')).toBeNull();
    expect(screen.getByRole('button', { name: 'Crux Kilter, Crux · 12 x 12, Closest' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Climb here' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Crux Tension, Crux · 12 x 12' }));
    expect(handlers.onPickBoard).toHaveBeenCalledExactlyOnceWith(TENSION);
  });

  it('drops the gym line when the boards are at different gyms', () => {
    renderSlot({ kind: 'board_rows', boards: [KILTER, TENSION], gymName: null, also: null });
    expect(screen.queryByText(/walls$/)).toBeNull();
  });

  it.each<{ row: UnnamedInRangeRow; title: string; body: string }>([
    {
      row: MOONBOARD,
      title: 'A MoonBoard is in range',
      body: "MoonBoards don't send a serial number, so tell us where you are and we'll find this one.",
    },
    {
      row: BARE_TENSION,
      title: 'A Tension board is in range',
      body: "Its box doesn't say which board it is, so tell us where you are and we'll find this one.",
    },
    {
      row: UNKNOWN_SETUP,
      title: 'A Kilter board is in range',
      body: "We don't know its setup yet, so tell us where you are and we'll find this one.",
    },
  ])('leads with $row.kind it cannot name, with its three ways forward', ({ row, title, body }) => {
    renderSlot({ kind: 'unnamed', row, boards: [] });
    expect(screen.getByText('In front of you')).toBeTruthy();
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(buttons()).toEqual(['Use my location', 'Search gyms', "It's my own board"]);
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search gyms' }));
    fireEvent.click(screen.getByRole('button', { name: "It's my own board" }));
    expect(handlers.onUseMyLocation).toHaveBeenCalledExactlyOnceWith(row);
    expect(handlers.onSearchGyms).toHaveBeenCalledExactlyOnceWith(row);
    expect(handlers.onOwnBoard).toHaveBeenCalledExactlyOnceWith(row);
  });

  // A MoonBoard beside a saved Kilter is not the Kilter: only the lead says
  // "In front of you", and the named board follows without a Closest pill.
  it('lists named boards after an unnamed lead, without a second "In front of you"', () => {
    renderSlot({ kind: 'unnamed', row: MOONBOARD, boards: [KILTER] });
    expect(screen.getAllByText('In front of you')).toHaveLength(1);
    expect(screen.queryByText('Closest')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Crux Kilter, Crux · 12 x 12' }));
    expect(handlers.onPickBoard).toHaveBeenCalledExactlyOnceWith(KILTER);
  });

  it('asks for signal when serials could not be looked up, with Retry, named boards following', () => {
    renderSlot({ kind: 'lookup_failed', boards: [KILTER] });
    expect(screen.getByText('Found a board, need signal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Crux Kilter, Crux · 12 x 12' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetryLookup).toHaveBeenCalledOnce();
  });

  // A named lead with a box it can't name behind it: one compact row, whose
  // three ways forward open on a tap.
  it('shows a box it cannot name under a named lead as one compact row', () => {
    renderSlot({ kind: 'hero', board: KILTER, also: { kind: 'unnamed', row: MOONBOARD } });
    expect(screen.getAllByText('In front of you')).toHaveLength(1);
    expect(screen.getByText('A MoonBoard is also in range')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use my location' })).toBeNull();

    fireEvent.click(screen.getByText('A MoonBoard is also in range'));
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(handlers.onUseMyLocation).toHaveBeenCalledExactlyOnceWith(MOONBOARD);
    expect(screen.getByRole('button', { name: 'Search gyms' })).toBeTruthy();
    expect(screen.getByRole('button', { name: "It's my own board" })).toBeTruthy();
  });

  it('names the type in the compact row for a box that is not a MoonBoard', () => {
    renderSlot({
      kind: 'board_rows',
      boards: [KILTER, TENSION],
      gymName: 'Crux',
      also: { kind: 'unnamed', row: BARE_TENSION },
    });
    expect(screen.getByText('A Tension board is also in range')).toBeTruthy();
  });

  it('offers Retry in the compact row for serials it could not look up', () => {
    renderSlot({ kind: 'hero', board: KILTER, also: { kind: 'lookup_failed' } });
    expect(screen.getByText('Another board is in range. We need signal to name it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetryLookup).toHaveBeenCalledOnce();
  });

  // Scan again belongs to the states where scanning again can change the answer
  // without anything else changing first.
  it.each<{ name: string; content: InRangeContent<DiscoveryBoardItem>; offersScanAgain: boolean }>([
    { name: 'Bluetooth off', content: { kind: 'blocked_off' }, offersScanAgain: true },
    { name: 'unreachable', content: { kind: 'unreachable' }, offersScanAgain: true },
    { name: 'nothing heard', content: { kind: 'none_in_range' }, offersScanAgain: true },
    { name: 'refused for good', content: { kind: 'blocked_denied' }, offersScanAgain: false },
    { name: 'a board in range', content: { kind: 'hero', board: KILTER, also: null }, offersScanAgain: false },
    { name: 'looking', content: { kind: 'looking' }, offersScanAgain: false },
  ])('Scan again for $name: $offersScanAgain', ({ content, offersScanAgain }) => {
    renderSlot(content);
    expect(screen.queryByRole('button', { name: 'Scan again' }) !== null).toBe(offersScanAgain);
  });
});
