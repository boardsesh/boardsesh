// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { PlayDrawerSectionId, PlayDrawerSectionsVisibility } from '../../../lib/play-drawer-sections-preference';

const preferences = vi.hoisted(() => ({
  sections: {
    logbook: true,
    climberLogs: true,
    setterNotes: true,
    betaVideos: true,
    boardseshGrade: true,
    community: true,
    similarClimbs: true,
  } as PlayDrawerSectionsVisibility,
  ready: true,
  setSection: vi.fn(),
  setAll: vi.fn(),
}));
vi.mock('../../../lib/play-drawer-sections-preference', () => ({
  PLAY_DRAWER_SECTION_IDS: [
    'logbook',
    'climberLogs',
    'setterNotes',
    'betaVideos',
    'boardseshGrade',
    'community',
    'similarClimbs',
  ],
  usePlayDrawerSectionsPreference: () => preferences,
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: 'secondary',
      secondaryBackground: 'surface',
      groupedBackground: 'grouped',
      separator: 'separator',
    },
  }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ header, children, scrollable }: { header?: ReactNode; children?: ReactNode; scrollable?: boolean }) =>
    createElement('div', { 'data-sheet': 'true', 'data-scrollable': String(scrollable) }, header, children),
}));
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: { title: string; leading: { kind: string; onPress: () => void } }) =>
    createElement(
      'header',
      null,
      title,
      createElement('button', { onClick: leading.onPress, 'aria-label': leading.kind }, leading.kind),
    ),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    disabled,
    variant,
    minHeight,
    testID,
    style,
  }: {
    title: string;
    onPress: () => void;
    disabled: boolean;
    variant: string;
    minHeight: number;
    testID: string;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        disabled,
        'data-testid': testID,
        'data-variant': variant,
        'data-min-height': minHeight,
        'data-style': JSON.stringify(style),
      },
      title,
    ),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children) }));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
    disabled,
  }: {
    label: string;
    value: boolean;
    onValueChange: (enabled: boolean) => void;
    disabled: boolean;
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
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
    ListFooterComponent,
  }: {
    data: Array<{ id: PlayDrawerSectionId }>;
    renderItem: (entry: { item: { id: PlayDrawerSectionId }; index: number }) => ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      'section',
      { 'data-sheet-list': 'true' },
      ...data.map((item, index) => createElement('div', { key: item.id }, renderItem({ item, index }))),
      createElement('footer', null, ListFooterComponent),
    ),
}));

import { PlayDrawerSectionsSheet } from '../PlayDrawerSectionsSheet';

beforeEach(() => {
  preferences.sections = {
    logbook: true,
    climberLogs: true,
    setterNotes: true,
    betaVideos: true,
    boardseshGrade: true,
    community: true,
    similarClimbs: true,
  };
  preferences.ready = true;
  preferences.setAll.mockClear();
  preferences.setSection.mockClear();
});
afterEach(cleanup);

describe('PlayDrawerSectionsSheet', () => {
  it('pins equal text bulk actions above the virtualized switches and explains immediate choices', () => {
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    expect(screen.getByText('mobile.settings.climbDrawer.sheetTitle')).toBeTruthy();
    expect(screen.getByText('mobile.settings.climbDrawer.groupTitle')).toBeTruthy();
    const showAll = screen.getByTestId('play-drawer-sections-show-all');
    const hideAll = screen.getByTestId('play-drawer-sections-hide-all');
    expect(showAll.closest('[data-sheet-list]')).toBeNull();
    expect(hideAll.closest('[data-sheet-list]')).toBeNull();
    expect(showAll.parentElement?.nextElementSibling).toBe(hideAll.parentElement);
    for (const button of [showAll, hideAll]) {
      expect(button.getAttribute('data-variant')).toBe('text');
      expect(button.getAttribute('data-min-height')).toBe('44');
      expect(button.getAttribute('data-style')).toContain('"width":"100%"');
      expect(button.parentElement?.getAttribute('data-style')).toContain('"flex":1');
    }
    expect(screen.getAllByRole('switch')).toHaveLength(7);
    expect(screen.container.querySelector('[data-sheet]')?.getAttribute('data-scrollable')).toBe('false');
    expect(screen.getByText('mobile.settings.climbDrawer.footer').closest('footer')).toBeTruthy();
  });

  it('disables redundant bulk actions and enables both for mixed choices', () => {
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const showAll = screen.getByTestId('play-drawer-sections-show-all') as HTMLButtonElement;
    const hideAll = screen.getByTestId('play-drawer-sections-hide-all') as HTMLButtonElement;
    expect(showAll.disabled).toBe(true);
    expect(hideAll.disabled).toBe(false);
    preferences.sections = { ...preferences.sections, logbook: false };
    screen.rerender(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    expect(showAll.disabled).toBe(false);
    expect(hideAll.disabled).toBe(false);
    preferences.sections = {
      logbook: false,
      climberLogs: false,
      setterNotes: false,
      betaVideos: false,
      boardseshGrade: false,
      community: false,
      similarClimbs: false,
    };
    screen.rerender(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    expect(showAll.disabled).toBe(false);
    expect(hideAll.disabled).toBe(true);
  });

  it('applies individual and bulk choices immediately, with close only dismissing the sheet', () => {
    preferences.sections = { ...preferences.sections, logbook: false };
    const onClose = vi.fn();
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose }));
    fireEvent.click(screen.getByRole('switch', { name: 'mobile.settings.climbDrawer.sections.logbook' }));
    expect(preferences.setSection).toHaveBeenCalledWith('logbook', true);
    fireEvent.click(screen.getByTestId('play-drawer-sections-show-all'));
    fireEvent.click(screen.getByTestId('play-drawer-sections-hide-all'));
    expect(preferences.setAll.mock.calls).toEqual([[true], [false]]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps switches and both bulk actions inert until preferences are ready', () => {
    preferences.ready = false;
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    expect(screen.getAllByRole('switch').every((control) => (control as HTMLInputElement).disabled)).toBe(true);
    for (const action of ['show-all', 'hide-all']) {
      const button = screen.getByTestId(`play-drawer-sections-${action}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(preferences.setAll).not.toHaveBeenCalled();
  });
});
