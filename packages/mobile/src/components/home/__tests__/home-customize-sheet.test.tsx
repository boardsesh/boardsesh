// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { SettingsChange } from '../../../settings/hooks';

const settings = vi.hoisted(() => ({
  listeners: new Set<(change: SettingsChange) => void>(),
  values: new Map<string, unknown>(),
}));
const analytics = vi.hoisted(() => ({ trackSettingChanged: vi.fn() }));
vi.mock('../../../settings/hooks', () => ({
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
  getSetting: (key: string) => settings.values.get(key) ?? null,
  setSetting: (key: string, value: unknown) => {
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));
vi.mock('../../../lib/settings-analytics', () => ({ trackSettingChanged: analytics.trackSettingChanged }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: vi.fn() }));
vi.mock('../../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('react-native', () => ({
  FlatList: () => null,
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: 'brand' },
    systemColors: {
      secondaryLabel: 'secondary',
      tertiaryLabel: 'tertiary',
      secondaryBackground: 'surface',
      groupedBackground: 'grouped',
      separator: 'separator',
    },
  }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ header, children }: { header?: ReactNode; children?: ReactNode }) =>
    createElement('div', { 'data-sheet': 'true' }, header, children),
}));
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title }: { title: string }) => createElement('header', null, title),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    disabled,
    testID,
  }: {
    title: string;
    onPress: () => void;
    disabled: boolean;
    testID: string;
  }) => createElement('button', { onClick: onPress, disabled, 'data-testid': testID }, title),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
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
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children) }));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (enabled: boolean) => void;
  }) =>
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked: value,
      onChange: () => onValueChange(!value),
    }),
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: Array<{ id: string }>;
    renderItem: (entry: { item: { id: string }; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      'section',
      null,
      createElement('header', null, ListHeaderComponent),
      ...data.map((item, index) => createElement('div', { key: item.id }, renderItem({ item, index }))),
      createElement('footer', null, ListFooterComponent),
    ),
}));

import { HomeCustomizeSheet } from '../HomeCustomizeSheet';
import { useHomeSectionControls } from '../use-home-section-controls';
import { homeSectionsStore, isDefaultHomeLayout, isFocusedHomeLayout } from '../../../lib/home-sections';

const SECTION_KEY = 'mobile.settings.homeSections.sections';

function renderSheet() {
  render(createElement(HomeCustomizeSheet, { visible: true, onClose: vi.fn() }));
}

function switchLabels(): string[] {
  return screen.getAllByRole('switch').map((element) => element.getAttribute('aria-label') ?? '');
}

beforeEach(() => {
  settings.values.clear();
  homeSectionsStore.restoreDefaults();
  analytics.trackSettingChanged.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('HomeCustomizeSheet', () => {
  it("lists today's Home with the feed last and without arrows", () => {
    renderSheet();
    expect(switchLabels()).toEqual([
      `${SECTION_KEY}.week`,
      `${SECTION_KEY}.session`,
      `${SECTION_KEY}.climbingNow`,
      `${SECTION_KEY}.projects`,
      `${SECTION_KEY}.playlists`,
      `${SECTION_KEY}.board`,
      `${SECTION_KEY}.beta`,
      `${SECTION_KEY}.feed`,
    ]);
    expect(screen.getAllByRole('switch').map((element) => (element as HTMLInputElement).checked)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
    ]);
    expect(screen.getByTestId('section-layout-move-up-climbingNow')).toBeTruthy();
    expect(screen.queryByTestId('section-layout-move-up-feed')).toBeNull();
    expect(screen.queryByTestId('section-layout-move-down-feed')).toBeNull();
    expect((screen.getByTestId('home-customize-restore-defaults') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Focused turns on Session, Back to your projects, At your level and Your board, and hides the feed and Climbing now', () => {
    renderSheet();
    act(() => {
      fireEvent.click(screen.getByTestId('home-customize-focused'));
    });
    expect(isFocusedHomeLayout(homeSectionsStore.getLayout())).toBe(true);
    expect(analytics.trackSettingChanged).toHaveBeenCalledWith('homeScreen', 'preset', 'focused');
    expect((screen.getByTestId('home-customize-focused') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('home-customize-restore-defaults') as HTMLButtonElement).disabled).toBe(false);
  });

  it('moves a section with its arrows and reports the move by section id', () => {
    renderSheet();
    act(() => {
      fireEvent.click(screen.getByTestId('section-layout-move-up-climbingNow'));
    });
    expect(homeSectionsStore.getLayout().order).toEqual([
      'week',
      'climbingNow',
      'session',
      'projects',
      'playlists',
      'board',
      'beta',
      'feed',
    ]);
    expect(switchLabels()[1]).toBe(`${SECTION_KEY}.climbingNow`);
    expect(analytics.trackSettingChanged).toHaveBeenCalledWith('homeScreen', 'moveUp', 'climbingNow');
  });

  it('switches a section and Restore defaults brings back today’s Home', () => {
    renderSheet();
    act(() => {
      fireEvent.click(screen.getByRole('switch', { name: `${SECTION_KEY}.feed` }));
    });
    expect(homeSectionsStore.getLayout().visible.feed).toBe(false);
    expect(analytics.trackSettingChanged).toHaveBeenCalledWith('homeScreen', 'feed', false);
    act(() => {
      fireEvent.click(screen.getByTestId('home-customize-restore-defaults'));
    });
    expect(isDefaultHomeLayout(homeSectionsStore.getLayout())).toBe(true);
    expect(settings.values.get('homeSectionsV1')).toBeNull();
  });

  it('refuses a move that cannot happen, without reporting it', () => {
    const { result } = renderHook(() => useHomeSectionControls());
    let moved: boolean | undefined;
    act(() => {
      moved = result.current.onMove('beta', 1);
    });
    expect(moved).toBe(false);
    expect(analytics.trackSettingChanged).not.toHaveBeenCalled();
    act(() => {
      moved = result.current.onMove('board', 1);
    });
    expect(moved).toBe(true);
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
  });
});
