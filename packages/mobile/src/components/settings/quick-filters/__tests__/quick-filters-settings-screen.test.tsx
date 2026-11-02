// @vitest-environment jsdom
import { createElement, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { MoreButtonRow, MoreCustomRow, MoreFormModel, MoreToggleRow } from '../../../MoreForm.types';

// The real page, hooks, pin stores and switch-and-arrow rows; only the native
// form, the platform primitives, storage and the reporting are stand-ins.
const captured = vi.hoisted(() => ({ model: null as MoreFormModel | null }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
const announce = vi.hoisted(() => ({ announceQueued: vi.fn() }));
const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
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
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  FlatList: () => null,
}));
vi.mock('react-native-paper', () => ({ Surface: ({ children }: { children?: ReactNode }) => children }));
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
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked: value,
      disabled,
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
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: 'brand' } }),
}));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../lib/announce-queued', () => ({ announceQueued: announce.announceQueued }));

import { QuickFiltersSettingsScreen } from '../QuickFiltersSettingsScreen';
import { climbPinnedChipsStore, STORAGE_KEY } from '../../../../lib/pinned-chips-store';
import {
  PLAYLIST_PINNED_CHIPS_STORAGE_KEY,
  playlistPinnedChipsStore,
} from '../../../../lib/playlist-pinned-chips-store';

function rows() {
  return captured.model?.sections.flatMap((section) => section.rows) ?? [];
}
function rowOfKind(key: string, kind: string) {
  const row = rows().find((candidate) => candidate.key === key);
  if (row?.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return row;
}
const toggle = (key: string) => rowOfKind(key, 'toggle') as MoreToggleRow;
const hostedRow = (key: string) => rowOfKind(key, 'custom') as MoreCustomRow;
const sectionRows = (key: string) =>
  (captured.model?.sections.find((section) => section.key === key)?.rows ?? []) as MoreToggleRow[];

function renderHosted(key: string) {
  const { content } = hostedRow(key);
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
const stored = (key: string): unknown => JSON.parse(storage.get(key) ?? 'null');

async function renderLoaded() {
  render(createElement(QuickFiltersSettingsScreen));
  // Both stores load from storage on mount; until then every control is greyed out.
  await waitFor(() => expect(toggle('climbs.accuracy').disabled).toBeUndefined());
  await waitFor(() => expect(toggle('playlists.accuracy').disabled).toBeUndefined());
}

beforeEach(() => {
  storage.clear();
  climbPinnedChipsStore.resetForTests();
  playlistPinnedChipsStore.resetForTests();
  analytics.track.mockClear();
  announce.announceQueued.mockClear();
  captured.model = null;
  platform.OS = 'ios';
});

afterEach(() => {
  cleanup();
});

describe('QuickFiltersSettingsScreen', () => {
  it('hosts each list’s pinned filters in the saved order, the rest as switches, then Restore defaults', async () => {
    storage.set(PLAYLIST_PINNED_CHIPS_STORAGE_KEY, JSON.stringify(['sort', 'beta', 'grade']));
    await renderLoaded();
    expect(captured.model?.sections.map((section) => section.key)).toEqual([
      'climbsPinned',
      'climbsUnpinned',
      'playlistsPinned',
      'playlistsUnpinned',
      'presets',
    ]);
    const playlists = renderHosted('playlistsPinnedRows');
    expect(switchLabels(playlists.container)).toEqual([
      'mobile.filter.sortBy',
      'mobile.filter.betaVideos',
      'mobile.filter.gradeRange',
    ]);
    expect(sectionRows('playlistsUnpinned').map((row) => row.key)).toEqual([
      'playlists.accuracy',
      'playlists.progress',
      'playlists.climbType',
      'playlists.popularity',
      'playlists.rating',
      'playlists.boardFit',
    ]);
    // A first guess until the list reports what it drew: three rows at the default text size.
    expect(hostedRow('playlistsPinnedRows').height).toBe(3 * 68);
  });

  it('moves a hosted row, saves the order and reports it', async () => {
    await renderLoaded();
    const climbs = renderHosted('climbsPinnedRows');
    expect(
      (climbs.container.querySelector('[data-testid="section-layout-move-up-recent"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(climbs.container.querySelector('[data-testid="section-layout-move-up-rating"]') as HTMLElement);
    });
    expect(settingChangedCalls()).toEqual([{ page: 'quickFilters', key: 'climbs.moveUp', value: 'rating' }]);
    expect(await climbPinnedChipsStore.load()).toEqual([
      'recent',
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'rating',
      'popularity',
    ]);
    expect(stored(STORAGE_KEY)).toEqual([
      'recent',
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'shape',
      'rating',
      'popularity',
    ]);
    expect(announce.announceQueued).toHaveBeenCalledWith(
      `mobile.settings.sectionLayout.moved ${JSON.stringify({ section: 'mobile.filter.minRating', position: 7, count: 8 })}`,
    );
  });

  it('pins a switched-on filter last and unpins a switched-off one', async () => {
    await renderLoaded();
    await act(async () => toggle('playlists.beta').onValueChange(true));
    expect(await playlistPinnedChipsStore.load()).toEqual(['grade', 'progress', 'sort', 'beta']);
    expect(settingChangedCalls()).toEqual([{ page: 'quickFilters', key: 'playlists.beta', value: true }]);

    const playlists = renderHosted('playlistsPinnedRows');
    expect(switchLabels(playlists.container).at(-1)).toBe('mobile.filter.betaVideos');
    await act(async () => {
      fireEvent.click(playlists.container.querySelector('[aria-label="mobile.filter.gradeRange"]') as HTMLElement);
    });
    expect(await playlistPinnedChipsStore.load()).toEqual(['progress', 'sort', 'beta']);
    expect(sectionRows('playlistsUnpinned')[0].key).toBe('playlists.grade');
    // The Climbs list never heard about it.
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it('on Android, draws native switches in the saved order with move buttons, and a move saves the order', async () => {
    platform.OS = 'android';
    storage.set(PLAYLIST_PINNED_CHIPS_STORAGE_KEY, JSON.stringify(['sort', 'grade']));
    await renderLoaded();
    expect(rows().some((row) => row.kind === 'custom')).toBe(false);
    expect(sectionRows('playlistsPinned').map((row) => [row.key, row.value])).toEqual([
      ['playlists.sort', true],
      ['playlists.grade', true],
    ]);
    await act(async () => toggle('playlists.grade').actions?.[0].onPress());
    expect(await playlistPinnedChipsStore.load()).toEqual(['grade', 'sort']);
    expect(settingChangedCalls()).toEqual([{ page: 'quickFilters', key: 'playlists.moveUp', value: 'grade' }]);
    expect(sectionRows('playlistsPinned').map((row) => row.key)).toEqual(['playlists.grade', 'playlists.sort']);

    // A button at the end does nothing.
    await act(async () => toggle('playlists.grade').actions?.[0].onPress());
    expect(settingChangedCalls()).toHaveLength(1);
  });

  it('offers Restore defaults once a list changed, and restores both', async () => {
    storage.set(STORAGE_KEY, JSON.stringify(['sort', 'grade']));
    await renderLoaded();
    const restore = () => rowOfKind('restoreDefaults', 'button') as MoreButtonRow;
    expect(restore().disabled).toBe(false);
    await act(async () => restore().onPress());
    expect(await climbPinnedChipsStore.load()).toEqual(climbPinnedChipsStore.defaults);
    expect(await playlistPinnedChipsStore.load()).toEqual(playlistPinnedChipsStore.defaults);
    expect(restore().disabled).toBe(true);
    expect(settingChangedCalls()).toEqual([{ page: 'quickFilters', key: 'preset', value: 'default' }]);
  });
});
