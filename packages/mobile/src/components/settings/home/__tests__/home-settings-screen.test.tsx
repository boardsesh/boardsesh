// @vitest-environment jsdom
import { createElement, isValidElement, useSyncExternalStore, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  MoreButtonRow,
  MoreCustomRow,
  MoreFormModel,
  MoreSegmentedRow,
  MoreToggleRow,
} from '../../../MoreForm.types';
import type { SettingsChange } from '../../../../settings/hooks';

// The real controls, store, switch-and-arrow rows and Customize sheet; only the
// native form, the platform primitives, the reporting and the settings file are
// stand-ins.
const captured = vi.hoisted(() => ({
  model: null as MoreFormModel | null,
  layoutHandlers: new Map<string, (event: { nativeEvent: { layout: { width: number; height: number } } }) => void>(),
}));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
const announce = vi.hoisted(() => ({ announceQueued: vi.fn() }));
const settings = vi.hoisted(() => ({
  listeners: new Set<(change: SettingsChange) => void>(),
  values: new Map<string, unknown>(),
}));
const settingsFile = vi.hoisted(() => ({
  subscribe: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => {
      settings.listeners.delete(listener);
    };
  },
  get: (key: string) => settings.values.get(key) ?? null,
  set: (key: string, value: unknown) => {
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('react-native', () => ({
  Platform: platform,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  useWindowDimensions: () => ({ width: 375, height: 667, fontScale: 1, scale: 2 }),
  View: ({
    children,
    testID,
    onLayout,
  }: {
    children?: ReactNode;
    testID?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    if (testID && onLayout) captured.layoutHandlers.set(testID, onLayout);
    return createElement('div', { 'data-testid': testID }, children);
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  FlatList: () => null,
}));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    captured.model = model;
    return null;
  },
}));
vi.mock('../../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked: value,
      onChange: () => onValueChange(!value),
    }),
}));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID }, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}));
vi.mock('../../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../../ModalSheet', () => ({
  ModalSheet: ({ visible, header, children }: { visible: boolean; header?: ReactNode; children?: ReactNode }) =>
    visible ? createElement('section', { 'data-testid': 'sheet' }, header, children) : null,
}));
vi.mock('../../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
  }: {
    data: Array<{ id: string }>;
    renderItem: (entry: { item: { id: string }; index: number }) => ReactNode;
  }) =>
    createElement(
      'ol',
      null,
      ...data.map((item, index) => createElement('li', { key: item.id }, renderItem({ item, index }))),
    ),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: 'brand' } }),
}));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../lib/announce-queued', () => ({ announceQueued: announce.announceQueued }));
vi.mock('../../../../settings/hooks', () => ({
  subscribeSettings: settingsFile.subscribe,
  getSetting: settingsFile.get,
  setSetting: settingsFile.set,
}));
vi.mock('../../../../settings', () => ({
  useSetting: (key: string) => {
    const value = useSyncExternalStore(settingsFile.subscribe, () => settingsFile.get(key));
    return [value, (next: unknown) => settingsFile.set(key, next)];
  },
}));

import { HomeSettingsScreen } from '../HomeSettingsScreen';
import { HomeCustomizeSheet } from '../../../home/HomeCustomizeSheet';
import { homeSectionsStore, visibleTopHomeSections } from '../../../../lib/home-sections';

const SECTION_KEY = 'mobile.settings.homeSections.sections';

function rows() {
  return captured.model?.sections.flatMap((section) => section.rows) ?? [];
}
function rowOfKind(key: string, kind: string) {
  const row = rows().find((candidate) => candidate.key === key);
  if (row?.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return row;
}
const toggle = (key: string) => rowOfKind(key, 'toggle') as MoreToggleRow;
const button = (key: string) => rowOfKind(key, 'button') as MoreButtonRow;
const segmented = (key: string) => rowOfKind(key, 'segmented') as MoreSegmentedRow;
const hostedRow = () => rowOfKind('movableSections', 'custom') as MoreCustomRow;

/** Draws the hosted React Native row the way the native form would, into its own container. */
function renderHostedRows() {
  const { content } = hostedRow();
  if (!isValidElement(content)) throw new Error('hosted row has no element');
  return render(content);
}

function switchLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="switch"]')].map((element) => element.getAttribute('aria-label') ?? '');
}

function settingChangedCalls() {
  return analytics.track.mock.calls
    .filter(([event]) => event === 'Setting Changed')
    .map(([, properties]) => properties);
}

beforeEach(() => {
  settings.values.clear();
  homeSectionsStore.restoreDefaults();
  analytics.track.mockClear();
  captured.model = null;
  captured.layoutHandlers.clear();
  platform.OS = 'ios';
  announce.announceQueued.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('HomeSettingsScreen', () => {
  it('runs Open the app on, the sections, the feed, then the presets', () => {
    render(createElement(HomeSettingsScreen));
    expect(captured.model?.sections.map((section) => section.key)).toEqual([
      'startup',
      'sections',
      'fixedSections',
      'presets',
    ]);
    expect(captured.model?.sections[2].rows.map((row) => row.key)).toEqual(['feed']);
    expect(captured.model?.sections[3].rows.map((row) => row.key)).toEqual(['showAll', 'focused', 'restoreDefaults']);
  });

  it('hosts the movable sections with switches and arrows, in the saved order, the feed left out', () => {
    homeSectionsStore.move('playlists', -1);
    render(createElement(HomeSettingsScreen));
    expect(hostedRow().fullBleed).toBe(true);
    // A first guess until the list reports what it drew: seven rows at the default text size.
    expect(hostedRow().height).toBe(7 * 68);
    const { container } = renderHostedRows();
    expect(switchLabels(container)).toEqual([
      `${SECTION_KEY}.week`,
      `${SECTION_KEY}.session`,
      `${SECTION_KEY}.climbingNow`,
      `${SECTION_KEY}.playlists`,
      `${SECTION_KEY}.projects`,
      `${SECTION_KEY}.board`,
      `${SECTION_KEY}.beta`,
    ]);
    expect(container.querySelector('[data-testid="section-layout-move-up-board"]')).not.toBeNull();
    const lastDown = container.querySelector('[data-testid="section-layout-move-down-beta"]') as HTMLButtonElement;
    expect(lastDown.disabled).toBe(true);
  });

  it('sizes the hosted row to what the list drew, and keeps the guess while nothing is drawn yet', () => {
    render(createElement(HomeSettingsScreen));
    renderHostedRows();
    const reportLayout = captured.layoutHandlers.get('home-settings-sections');
    if (!reportLayout) throw new Error('hosted rows report no layout');
    act(() => reportLayout({ nativeEvent: { layout: { width: 0, height: 0 } } }));
    expect(hostedRow().height).toBe(7 * 68);
    act(() => reportLayout({ nativeEvent: { layout: { width: 343, height: 321.4 } } }));
    expect(hostedRow().height).toBe(322);
  });

  it('agrees with the sheet and Home: a move on the page is where both draw it', () => {
    render(createElement(HomeSettingsScreen));
    const hosted = renderHostedRows();
    act(() => {
      fireEvent.click(hosted.container.querySelector('[data-testid="section-layout-move-up-beta"]') as HTMLElement);
    });
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'moveUp', value: 'beta' }]);
    expect(homeSectionsStore.getLayout().order).toEqual([
      'week',
      'session',
      'climbingNow',
      'projects',
      'playlists',
      'beta',
      'board',
      'feed',
    ]);

    act(() => {
      homeSectionsStore.setVisible('beta', true);
    });
    // Home draws the switched-on sections above the feed in the stored order.
    expect(visibleTopHomeSections(homeSectionsStore.getLayout())).toEqual([
      'week',
      'session',
      'climbingNow',
      'projects',
      'playlists',
      'beta',
    ]);

    cleanup();
    render(createElement(HomeCustomizeSheet, { visible: true, onClose: vi.fn() }));
    expect(screen.getAllByRole('switch').map((element) => element.getAttribute('aria-label'))).toEqual([
      `${SECTION_KEY}.week`,
      `${SECTION_KEY}.session`,
      `${SECTION_KEY}.climbingNow`,
      `${SECTION_KEY}.projects`,
      `${SECTION_KEY}.playlists`,
      `${SECTION_KEY}.beta`,
      `${SECTION_KEY}.board`,
      `${SECTION_KEY}.feed`,
    ]);
  });

  it('on Android, draws native switches in the saved order with move buttons, and a move saves the order', () => {
    platform.OS = 'android';
    homeSectionsStore.move('playlists', -1);
    render(createElement(HomeSettingsScreen));
    const sectionRows = () =>
      (captured.model?.sections.find((section) => section.key === 'sections')?.rows ?? []) as MoreToggleRow[];
    expect(sectionRows().map((row) => [row.kind, row.key])).toEqual([
      ['toggle', 'week'],
      ['toggle', 'session'],
      ['toggle', 'climbingNow'],
      ['toggle', 'playlists'],
      ['toggle', 'projects'],
      ['toggle', 'board'],
      ['toggle', 'beta'],
    ]);
    expect(rows().some((row) => row.kind === 'custom')).toBe(false);
    // Up then down on every row; the first can't go up, the last can't pass the feed.
    expect(sectionRows().map((row) => row.actions?.map((action) => `${action.icon}:${!action.disabled}`))).toEqual([
      ['moveUp:false', 'moveDown:true'],
      ['moveUp:true', 'moveDown:true'],
      ['moveUp:true', 'moveDown:true'],
      ['moveUp:true', 'moveDown:true'],
      ['moveUp:true', 'moveDown:true'],
      ['moveUp:true', 'moveDown:true'],
      ['moveUp:true', 'moveDown:false'],
    ]);
    expect(toggle('feed').actions).toBeUndefined();

    act(() => toggle('board').actions?.[0].onPress());
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'moveUp', value: 'board' }]);
    expect(settings.values.get('homeSectionsV1')).toMatchObject({
      order: ['week', 'session', 'climbingNow', 'playlists', 'board', 'projects', 'beta', 'feed'],
    });
    expect(announce.announceQueued).toHaveBeenCalledWith(
      `mobile.settings.sectionLayout.moved ${JSON.stringify({ section: `${SECTION_KEY}.board`, position: 5, count: 7 })}`,
    );
    expect(sectionRows().map((row) => row.key)).toEqual([
      'week',
      'session',
      'climbingNow',
      'playlists',
      'board',
      'projects',
      'beta',
    ]);

    // A disabled button does nothing.
    act(() => toggle('week').actions?.[0].onPress());
    expect(settingChangedCalls()).toHaveLength(1);

    act(() => toggle('board').onValueChange(true));
    expect(homeSectionsStore.getLayout().visible.board).toBe(true);
  });

  it('reports a switch once, under the Home page', () => {
    render(createElement(HomeSettingsScreen));
    act(() => toggle('feed').onValueChange(false));
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'feed', value: false }]);
    expect(homeSectionsStore.getLayout().visible.feed).toBe(false);
    expect(toggle('feed').value).toBe(false);
  });

  it('offers Focused and Restore defaults only when they would change something', () => {
    render(createElement(HomeSettingsScreen));
    expect(button('restoreDefaults').disabled).toBe(true);
    act(() => button('focused').onPress());
    expect(button('focused').disabled).toBe(true);
    expect(button('restoreDefaults').disabled).toBe(false);
    expect(toggle('feed').value).toBe(false);
    act(() => button('restoreDefaults').onPress());
    expect(toggle('feed').value).toBe(true);
    expect(settings.values.get('homeSectionsV1')).toBeNull();
  });

  it('shows Climbs for an unknown stored start-up tab, and saves a new one once, reporting it once', () => {
    settings.values.set('startupScreen', 'profile');
    render(createElement(HomeSettingsScreen));
    expect(segmented('startupScreen').selectedKey).toBe('climbs');
    act(() => segmented('startupScreen').onSelect('home'));
    expect(settings.values.get('startupScreen')).toBe('home');
    expect(segmented('startupScreen').selectedKey).toBe('home');
    act(() => segmented('startupScreen').onSelect('home'));
    expect(settingChangedCalls()).toEqual([{ page: 'homeScreen', key: 'startupScreen', value: 'home' }]);
  });
});
