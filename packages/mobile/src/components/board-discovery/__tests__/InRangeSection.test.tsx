// @vitest-environment jsdom
//
// The top of the board picker, rendered for every notice and lead
// picker-top-view.ts can produce: the copy (the shipped en-US catalog), the
// buttons and what each one calls, Open Settings dropping where the platform
// can't open it, and which states offer Scan again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import settingsCatalog from '@boardsesh/i18n/locales/en-US/settings.json';
import type { DiscoveryBoardItem } from '../BoardDiscoveryCardView';
import type { PickerScanNotice, PickerTopContent, UnnamedInRangeRow } from '../picker-top-view';
import type { InRangeLocationHint } from '../InRangeSection';
import type { BluetoothOffFix } from '../bluetooth-radio';

type Children = { children?: ReactNode };
const settingsCtrl = vi.hoisted(() => ({ canOpen: true }));
const windowCtrl = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: windowCtrl.fontScale }),
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
  Button: ({
    title,
    onPress,
    loading,
    style,
    maxFontSizeMultiplier,
  }: {
    title: string;
    onPress: () => void;
    loading?: boolean;
    style?: { height?: number };
    maxFontSizeMultiplier?: number;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'data-loading': loading ? 'yes' : 'no',
        'data-height': style?.height ?? 'auto',
        'data-max-font-scale': maxFontSizeMultiplier ?? 'none',
      },
      title,
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: Children & { onPress: () => void; accessibilityLabel?: string; accessibilityState?: { selected?: boolean } }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-selected': accessibilityState?.selected,
      },
      children,
    ),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
// The Velvet pieces as plain markup: a shelf is a heading and its content.
vi.mock('../../ShelfHeader', () => ({
  SHELF_SECTION_GAP: 28,
  ShelfSection: ({
    title,
    action,
    trailing,
    children,
  }: Children & {
    title: string;
    action?: { label: string; onPress: () => void; accessibilityLabel?: string };
    trailing?: ReactNode;
  }) =>
    createElement(
      'section',
      null,
      createElement('h2', null, title),
      action
        ? createElement(
            'button',
            { type: 'button', onClick: action.onPress, 'aria-label': action.accessibilityLabel ?? action.label },
            action.label,
          )
        : null,
      trailing,
      children,
    ),
}));
vi.mock('../../EmptyState', () => ({
  EmptyState: ({ title, actions }: { title: string; actions?: ReactNode }) =>
    createElement('div', null, createElement('span', null, title), actions),
}));
vi.mock('../../TextAction', () => ({
  TextAction: ({ label, onPress, reach }: { label: string; onPress: () => void; reach?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-reach': reach ?? 'even' }, label),
}));
vi.mock('../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children }: Children) => createElement('div', null, children),
  insetGroupedRowStyles: { row: {}, leading: {}, text: {} },
}));
vi.mock('../../ArtRow', () => ({
  ArtRow: ({ title, subtitle }: { title: string; subtitle?: ReactNode }) =>
    createElement('div', null, createElement('span', null, title), createElement('span', null, subtitle)),
}));
vi.mock('../../boards/BoardThumbnail', () => ({ BoardThumbnailView: () => null }));
// One row per board, named as VoiceOver reads it, saying whether it has a menu.
vi.mock('../BoardRow', () => ({
  BoardRow: ({
    item,
    onPress,
    menu,
    BoardArt,
  }: {
    item: DiscoveryBoardItem;
    onPress: (item: DiscoveryBoardItem) => void;
    menu?: unknown;
    BoardArt: (props: { item: DiscoveryBoardItem; size: string }) => ReactNode;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => onPress(item),
        'aria-label': [item.title, item.subtitle].filter(Boolean).join(', '),
        'aria-selected': item.isActive === true,
        'data-menu': menu ? 'yes' : 'no',
      },
      createElement(BoardArt, { item, size: 'regular' }),
      item.title,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      tertiaryBackground: '#eee',
      secondaryBackground: '#f5f5f5',
      separator: '#ccc',
      label: '#000',
      accent: '#6D28D9',
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
  key: 'crux-kilter',
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  title: 'Crux Kilter',
  subtitle: 'Crux · 12 x 12',
};
const TENSION: DiscoveryBoardItem = { ...KILTER, key: 'crux-tension', title: 'Crux Tension', subtitle: '12 x 12' };
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
  serials: ['751737'],
  serialLessBoxCount: 0,
};
type AtGym = Extract<PickerTopContent<DiscoveryBoardItem>, { kind: 'at_gym' }>;
const AT_CRUX: AtGym = {
  kind: 'at_gym',
  gymUuid: 'gym-crux',
  gymName: 'Crux',
  source: 'scan',
  rows: [
    { ...KILTER, subtitle: '12 x 12', isActive: true },
    { ...TENSION, isActive: false },
  ],
  heardKeys: new Set(),
};
const HERO: PickerTopContent<DiscoveryBoardItem> = { kind: 'hero', board: KILTER, strongestSignal: true };

const handlers = {
  onStart: vi.fn(),
  onOpenSettings: vi.fn(),
  onTurnOnBluetooth: vi.fn(),
  onBluetoothNotNow: vi.fn(),
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
  content: PickerTopContent<DiscoveryBoardItem>,
  {
    notice = null,
    unnamed = null,
    scanning = false,
    heardNothing = false,
    locationHint = null,
    bluetoothOffFix = 'control_center',
    withNotNow = true,
  }: {
    notice?: PickerScanNotice | null;
    unnamed?: UnnamedInRangeRow | null;
    scanning?: boolean;
    heardNothing?: boolean;
    locationHint?: InRangeLocationHint | null;
    bluetoothOffFix?: BluetoothOffFix;
    withNotNow?: boolean;
  } = {},
) {
  return render(
    <InRangeSection
      view={{ notice, content, unnamed, scanning, heardNothing, loudestBoardKey: null }}
      BoardArt={BoardArt}
      locationHint={locationHint}
      bluetoothOffFix={bluetoothOffFix}
      {...handlers}
      onBluetoothNotNow={withNotNow ? handlers.onBluetoothNotNow : undefined}
    />,
  );
}

function buttons(): string[] {
  return screen.queryAllByRole('button').map((button) => button.textContent ?? '');
}

function headings(): string[] {
  return screen.queryAllByRole('heading').map((heading) => heading.textContent ?? '');
}

beforeEach(() => {
  settingsCtrl.canOpen = true;
  windowCtrl.fontScale = 1;
  for (const handler of Object.values(handlers)) handler.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('InRangeSection', () => {
  it('draws nothing when nothing leads and the scan has nothing to say', () => {
    const { container } = renderSlot({ kind: 'none' });
    expect(container.textContent).toBe('');
  });

  // The "No boards in range · Scan again" line is gone: at home with nothing
  // heard, Your boards leads.
  it('draws nothing when the scan heard nothing', () => {
    const { container } = renderSlot({ kind: 'none' }, { heardNothing: true });
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Scan again' })).toBeNull();
  });

  // The states that are not about a board: one quiet line, no section title.
  it.each<{
    name: string;
    notice: PickerScanNotice;
    line: string;
    button: string | null;
    calls: keyof typeof handlers | null;
  }>([
    {
      name: 'Bluetooth refused for good',
      notice: { kind: 'blocked_denied' },
      line: 'Allow Bluetooth in Settings to spot the board in front of you.',
      button: 'Open Settings',
      calls: 'onOpenSettings',
    },
    {
      name: 'Bluetooth off on iOS',
      notice: { kind: 'blocked_off' },
      line: "Turn on Bluetooth in Control Center. We'll look for the board in front of you once it's on.",
      button: 'Scan again',
      calls: 'onStart',
    },
    {
      name: 'Bluetooth not allowed, after Not now',
      notice: { kind: 'permission_line' },
      line: 'Boardsesh needs Bluetooth to light climbs on the wall.',
      button: 'Allow Bluetooth',
      calls: 'onStart',
    },
    {
      name: 'Bluetooth unreachable, which may well be on',
      notice: { kind: 'unreachable' },
      line: "Couldn't reach Bluetooth.",
      button: 'Scan again',
      calls: 'onStart',
    },
  ])('$name: one quiet line', ({ notice, line, button, calls }) => {
    renderSlot({ kind: 'none' }, { notice });
    expect(headings()).toEqual([]);
    expect(screen.getByText(line)).toBeTruthy();
    expect(buttons()).toEqual(button ? [button] : []);
    if (button && calls) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(handlers[calls]).toHaveBeenCalledOnce();
      // The line tops the page; the next shelf header's action leans up across
      // the gap below it, so this one leans up too.
      expect(screen.getByRole('button', { name: button }).getAttribute('data-reach')).toBe('up');
    }
  });

  it('drops Open Settings where the platform cannot open it, keeping the line', () => {
    settingsCtrl.canOpen = false;
    renderSlot({ kind: 'none' }, { notice: { kind: 'blocked_denied' } });
    expect(screen.getByText('Allow Bluetooth in Settings to spot the board in front of you.')).toBeTruthy();
    expect(buttons()).toEqual([]);
  });

  // Android withholding the results: the fix shows where the top would be.
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
  ])('says Android hides the results ($hint) when the scan heard nothing', ({ hint, title, action }) => {
    const onPress = vi.fn();
    renderSlot({ kind: 'none' }, { heardNothing: true, locationHint: { kind: hint, busy: true, onPress } });

    expect(screen.getByText(title)).toBeTruthy();
    const fix = screen.getByRole('button', { name: action });
    expect(fix.getAttribute('data-loading')).toBe('yes');
    fireEvent.click(fix);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps the location hint to a scan that heard nothing', () => {
    renderSlot({ kind: 'none' }, { locationHint: { kind: 'grant_location', busy: false, onPress: vi.fn() } });
    expect(screen.queryByText('Android needs Location to see boards')).toBeNull();
  });

  it('asks for Bluetooth with Continue, under the In range title', () => {
    renderSlot({ kind: 'none' }, { notice: { kind: 'permission_card' } });
    expect(headings()).toEqual(['In range']);
    expect(screen.getByText("Spot the board you're at")).toBeTruthy();
    expect(buttons()).toEqual(['Continue', 'Not now']);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(handlers.onStart).toHaveBeenCalledOnce();
    expect(handlers.onBluetoothNotNow).not.toHaveBeenCalled();
  });

  it('turns the card into a line from then on with Not now, without asking', () => {
    renderSlot({ kind: 'none' }, { notice: { kind: 'permission_card' } });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(handlers.onBluetoothNotNow).toHaveBeenCalledOnce();
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('offers no Not now where the screen has nowhere to keep it', () => {
    renderSlot({ kind: 'none' }, { notice: { kind: 'permission_card' }, withNotNow: false });
    expect(buttons()).toEqual(['Continue']);
  });

  // The radio is off five times as often as the permission is blocked: the
  // line leads with the fix. Android can ask; iOS can only say where.
  it.each<{ fix: BluetoothOffFix; line: string; button: string; calls: keyof typeof handlers }>([
    { fix: 'turn_on', line: 'Bluetooth is off.', button: 'Turn on Bluetooth', calls: 'onTurnOnBluetooth' },
    {
      fix: 'control_center',
      line: "Turn on Bluetooth in Control Center. We'll look for the board in front of you once it's on.",
      button: 'Scan again',
      calls: 'onStart',
    },
  ])('Bluetooth off with $fix leads with "$line"', ({ fix, line, button, calls }) => {
    renderSlot({ kind: 'none' }, { notice: { kind: 'blocked_off' }, bluetoothOffFix: fix });
    expect(screen.getByText(line)).toBeTruthy();
    expect(buttons()).toEqual([button]);
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(handlers[calls]).toHaveBeenCalledOnce();
  });

  it('waits for a tap with the Scan card', () => {
    renderSlot({ kind: 'none' }, { notice: { kind: 'tap_to_scan' } });
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

  // The hero needs no title: "In front of you" says it.
  it('leads with the one board heard somewhere else, and Climb here picks it', () => {
    renderSlot(HERO);
    expect(headings()).toEqual([]);
    expect(screen.getByText('In front of you')).toBeTruthy();
    expect(screen.getByText('Crux Kilter')).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(buttons()).toEqual(['Climb here']);
    fireEvent.click(screen.getByRole('button', { name: 'Climb here' }));
    expect(handlers.onPickBoard).toHaveBeenCalledExactlyOnceWith(KILTER);
  });

  it("lists the gym's walls under At {gym}, with no caption, no Closest and no Climb here", () => {
    renderSlot(AT_CRUX);
    expect(headings()).toEqual(['At Crux']);
    expect(screen.queryByText(/walls$/)).toBeNull();
    expect(screen.queryByText('Closest')).toBeNull();
    expect(screen.queryByText('In front of you')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Climb here' })).toBeNull();
    const kilterRow = screen.getByRole('button', { name: 'Crux Kilter, 12 x 12' });
    expect(kilterRow.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Crux Tension, 12 x 12' }));
    // With its place in the list as drawn.
    expect(handlers.onPickBoard).toHaveBeenCalledExactlyOnceWith(AT_CRUX.rows[1], 1);
  });

  it("offers See gym on At {gym} only when the picker can open the gym's page", () => {
    const onSeeGym = vi.fn();
    const { rerender } = renderSlot(AT_CRUX);
    expect(screen.queryByRole('button', { name: 'See Crux' })).toBeNull();
    rerender(
      <InRangeSection
        bluetoothOffFix="control_center"
        view={{
          notice: null,
          content: AT_CRUX,
          unnamed: null,
          scanning: false,
          heardNothing: false,
          loudestBoardKey: null,
        }}
        BoardArt={BoardArt}
        onSeeGym={onSeeGym}
        {...handlers}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'See Crux' }));
    expect(onSeeGym).toHaveBeenCalledExactlyOnceWith('gym-crux');
  });

  it('puts the spinner by At {gym} while the scan listens, and nowhere else', () => {
    renderSlot(AT_CRUX, { scanning: true, notice: { kind: 'lookup_failed', besideHeardBoards: false } });
    expect(headings()).toEqual(['In range', 'At Crux']);
    expect(screen.getAllByTestId('spinner')).toHaveLength(1);
  });

  // The scan switched off: the Scan card, and the gym of the board you're on below it.
  it('shows the Scan card above At {gym}', () => {
    renderSlot({ ...AT_CRUX, source: 'active_board' }, { notice: { kind: 'tap_to_scan' } });
    expect(headings()).toEqual(['In range', 'At Crux']);
    expect(screen.getByRole('button', { name: 'Scan' })).toBeTruthy();
  });

  // A big gym and a ScrollView that can't hold a virtualised list: the first
  // few, then all after Show all, with the board you're on always shown.
  const EIGHT_WALLS: DiscoveryBoardItem[] = Array.from({ length: 8 }, (_unused, wallIndex) => ({
    ...KILTER,
    key: `wall-${wallIndex + 1}`,
    title: `Wall ${wallIndex + 1}`,
    isActive: wallIndex === 6,
  }));
  it('shows the first walls of a big gym and the one you are on, then all of them after Show all', () => {
    const { container } = renderSlot({ ...AT_CRUX, rows: EIGHT_WALLS });
    const shownWalls = () => [...container.querySelectorAll('[data-art]')].map((art) => art.getAttribute('data-art'));
    expect(shownWalls()).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-7']);

    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 boards' }));
    expect(shownWalls()).toHaveLength(8);
    expect(screen.queryByRole('button', { name: 'Show all 8 boards' })).toBeNull();
  });

  // Only the climber's own and followed walls have anything to pin, download or manage.
  it("offers the card menu only on the climber's own walls", () => {
    render(
      <InRangeSection
        bluetoothOffFix="control_center"
        view={{
          notice: null,
          content: AT_CRUX,
          unnamed: null,
          scanning: false,
          heardNothing: false,
          loudestBoardKey: null,
        }}
        BoardArt={BoardArt}
        {...handlers}
        atGymMenuCapabilities={{
          canPin: true,
          canDownload: true,
          canOpenDetails: true,
          canManage: true,
          canReport: false,
        }}
        onAtGymMenuAction={vi.fn()}
        atGymMenuKeys={new Set(['crux-kilter'])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Crux Kilter, 12 x 12' }).getAttribute('data-menu')).toBe('yes');
    expect(screen.getByRole('button', { name: 'Crux Tension, 12 x 12' }).getAttribute('data-menu')).toBe('no');
  });

  // The walls the scan heard stay in view past the cut, like the board you're on.
  it('keeps the walls the scan heard in view in a big gym', () => {
    const { container } = renderSlot({ ...AT_CRUX, rows: EIGHT_WALLS, heardKeys: new Set(['wall-5']) });
    const shownWalls = [...container.querySelectorAll('[data-art]')].map((art) => art.getAttribute('data-art'));
    expect(shownWalls).toEqual(['wall-1', 'wall-2', 'wall-5', 'wall-7']);
  });

  // A pick reports the row's place as drawn, not in the full roster.
  it('reports a pick from a collapsed gym at its place as drawn', () => {
    renderSlot({ ...AT_CRUX, rows: EIGHT_WALLS });
    fireEvent.click(screen.getByRole('button', { name: 'Wall 7, Crux · 12 x 12' }));
    expect(handlers.onPickBoard).toHaveBeenCalledExactlyOnceWith(EIGHT_WALLS[6], 3);
  });

  it('offers no Show all when it would hide one wall', () => {
    renderSlot({ ...AT_CRUX, rows: EIGHT_WALLS.slice(0, 5) });
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
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
    renderSlot({ kind: 'none' }, { unnamed: row });
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

  // A filled and a tonal button measure differently from the same label: the
  // pair shares one pinned height that grows with the text, labels uncapped.
  it.each([
    [1, '44'],
    [0.85, '44'],
    [1.5, '54'],
    [3.12, '86'],
  ])('draws Use my location and Search gyms at one height (text size %sx: %spt)', (fontScale, height) => {
    windowCtrl.fontScale = fontScale;
    renderSlot({ kind: 'none' }, { unnamed: MOONBOARD });
    const pair = ['Use my location', 'Search gyms'].map((name) => screen.getByRole('button', { name }));
    expect(pair.map((button) => button.getAttribute('data-height'))).toEqual([height, height]);
    expect(pair.map((button) => button.getAttribute('data-max-font-scale'))).toEqual(['none', 'none']);
  });

  // The gym of the board you're on doesn't say what this box is.
  it('shows a box it cannot name above At {gym}', () => {
    renderSlot({ ...AT_CRUX, source: 'active_board' }, { unnamed: MOONBOARD });
    expect(headings()).toEqual(['In range', 'At Crux']);
    expect(screen.getByText('A MoonBoard is in range')).toBeTruthy();
  });

  // Something was heard louder: the climber may be standing at that one.
  it('says "Nearby" on a hero that is not the strongest signal heard', () => {
    renderSlot({ ...HERO, strongestSignal: false } as PickerTopContent<DiscoveryBoardItem>);
    expect(screen.getByText('Nearby')).toBeTruthy();
    expect(screen.queryByText('In front of you')).toBeNull();
  });

  it('asks for signal when serials could not be looked up, with Retry', () => {
    renderSlot({ kind: 'none' }, { notice: { kind: 'lookup_failed', besideHeardBoards: false } });
    expect(screen.getByText('Found a board, need signal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetryLookup).toHaveBeenCalledOnce();
  });

  it.each<{ name: string; content: PickerTopContent<DiscoveryBoardItem> }>([
    { name: 'the hero', content: HERO },
    { name: 'At {gym}', content: AT_CRUX },
  ])('says so in one compact line beside $name', ({ content }) => {
    renderSlot(content, { notice: { kind: 'lookup_failed', besideHeardBoards: true } });
    expect(screen.queryByText('Found a board, need signal')).toBeNull();
    expect(screen.getByText('Another board is in range. We need signal to name it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetryLookup).toHaveBeenCalledOnce();
  });

  // Scan again belongs to the states where scanning again can change the answer
  // without anything else changing first.
  it.each<{
    name: string;
    content: PickerTopContent<DiscoveryBoardItem>;
    notice: PickerScanNotice | null;
    offersScanAgain: boolean;
  }>([
    { name: 'Bluetooth off', content: { kind: 'none' }, notice: { kind: 'blocked_off' }, offersScanAgain: true },
    { name: 'unreachable', content: { kind: 'none' }, notice: { kind: 'unreachable' }, offersScanAgain: true },
    { name: 'nothing heard', content: { kind: 'none' }, notice: null, offersScanAgain: false },
    { name: 'refused for good', content: { kind: 'none' }, notice: { kind: 'blocked_denied' }, offersScanAgain: false },
    { name: 'a board heard', content: HERO, notice: null, offersScanAgain: false },
    { name: 'At {gym}', content: AT_CRUX, notice: null, offersScanAgain: false },
    { name: 'looking', content: { kind: 'looking' }, notice: null, offersScanAgain: false },
  ])('Scan again for $name: $offersScanAgain', ({ content, notice, offersScanAgain }) => {
    renderSlot(content, { notice });
    expect(screen.queryByRole('button', { name: 'Scan again' }) !== null).toBe(offersScanAgain);
  });
});
