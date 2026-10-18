// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type {
  BelowFoldSectionId,
  PlayDrawerSectionId,
  PlayDrawerSectionsVisibility,
} from '../../../lib/play-drawer-sections-preference';

const DEFAULT_ORDER: BelowFoldSectionId[] = [
  'logbook',
  'climberLogs',
  'setterNotes',
  'betaVideos',
  'boardseshGrade',
  'community',
  'similarClimbs',
];

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
  order: [] as BelowFoldSectionId[],
  ready: true,
  setSection: vi.fn(),
  setAll: vi.fn(),
  move: vi.fn(),
  restoreDefaults: vi.fn(),
}));
const accessibility = vi.hoisted(() => ({ announce: vi.fn() }));
const presentation = vi.hoisted(() => ({
  platform: 'web',
  iosBackgroundStyle: undefined as { backgroundColor: string } | undefined,
}));
vi.mock('../../use-ios-sheet-background-style', () => ({
  useIosSheetBackgroundStyle: () => presentation.iosBackgroundStyle,
}));
vi.mock('../../../lib/play-drawer-sections-preference', () => {
  const order = ['logbook', 'climberLogs', 'setterNotes', 'betaVideos', 'boardseshGrade', 'community', 'similarClimbs'];
  return {
    PLAY_DRAWER_SECTION_IDS: order,
    isDefaultPlayDrawerLayout: ({ sections, order: current }: { sections: Record<string, boolean>; order: string[] }) =>
      Object.values(sections).every(Boolean) && current.join() === order.join(),
    usePlayDrawerSectionsPreference: () => preferences,
  };
});
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: accessibility.announce },
  FlatList: () => null,
  Platform: {
    get OS() {
      return presentation.platform;
    },
  },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style) }, children),
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
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    createElement(
      'button',
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'data-testid': testID },
      children,
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
    style,
  }: {
    data: Array<{ id: PlayDrawerSectionId }>;
    renderItem: (entry: { item: { id: PlayDrawerSectionId }; index: number }) => ReactNode;
    ListFooterComponent?: ReactNode;
    style?: unknown;
  }) =>
    createElement(
      'section',
      { 'data-sheet-list': 'true', 'data-style': JSON.stringify(style) },
      ...data.map((item, index) => createElement('div', { key: item.id }, renderItem({ item, index }))),
      createElement('footer', null, ListFooterComponent),
    ),
}));

import { PlayDrawerSectionsSheet } from '../PlayDrawerSectionsSheet';

beforeEach(() => {
  presentation.platform = 'web';
  presentation.iosBackgroundStyle = undefined;
  preferences.sections = {
    logbook: true,
    climberLogs: true,
    setterNotes: true,
    betaVideos: true,
    boardseshGrade: true,
    community: true,
    similarClimbs: true,
  };
  preferences.order = [...DEFAULT_ORDER];
  preferences.ready = true;
  preferences.setAll.mockClear();
  preferences.setSection.mockClear();
  preferences.move.mockClear();
  preferences.restoreDefaults.mockClear();
  accessibility.announce.mockClear();
});
afterEach(cleanup);

describe('PlayDrawerSectionsSheet', () => {
  it('leaves broad content grounds unpainted on native Apple iOS sheets, retaining the inset group surface', () => {
    presentation.platform = 'ios';
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const controlsGround = screen.getByText('mobile.settings.climbDrawer.description').parentElement;
    const list = screen.container.querySelector('[data-sheet-list]');
    expect(controlsGround?.getAttribute('data-style')).not.toContain('backgroundColor');
    expect(list?.getAttribute('data-style')).not.toContain('backgroundColor');
    expect(screen.getAllByRole('switch')[0]?.closest('[data-style*=\'"backgroundColor":"surface"\']')).not.toBeNull();
  });

  it.each([
    { platform: 'ios', iosBackgroundStyle: { backgroundColor: 'material-sheet' } },
    { platform: 'ios', iosBackgroundStyle: { backgroundColor: 'reduce-transparency-sheet' } },
    { platform: 'android', iosBackgroundStyle: undefined },
    { platform: 'web', iosBackgroundStyle: undefined },
  ])('preserves grouped content for opaque iOS fallbacks and other platforms: %j', (mode) => {
    presentation.platform = mode.platform;
    presentation.iosBackgroundStyle = mode.iosBackgroundStyle;
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const controlsGround = screen.getByText('mobile.settings.climbDrawer.description').parentElement;
    expect(controlsGround?.getAttribute('data-style')).toContain('"backgroundColor":"grouped"');
    expect(screen.container.querySelector('[data-sheet-list]')?.getAttribute('data-style')).toContain(
      '"backgroundColor":"grouped"',
    );
  });

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

  it('lists the rows in the saved order, each with a pair of arrows', () => {
    preferences.order = ['similarClimbs', ...DEFAULT_ORDER.filter((sectionId) => sectionId !== 'similarClimbs')];
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    expect(screen.getAllByRole('switch').map((control) => control.getAttribute('aria-label'))).toEqual(
      preferences.order.map((sectionId) => `mobile.settings.climbDrawer.sections.${sectionId}`),
    );
    expect(screen.container.querySelectorAll('[data-icon="arrow.up"]')).toHaveLength(7);
    expect(screen.container.querySelectorAll('[data-icon="arrow.down"]')).toHaveLength(7);
  });

  it('disables the arrows that would leave the list, and moves on the others', () => {
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const firstUp = screen.getByTestId('section-layout-move-up-logbook') as HTMLButtonElement;
    const lastDown = screen.getByTestId('section-layout-move-down-similarClimbs') as HTMLButtonElement;
    expect(firstUp.disabled).toBe(true);
    expect(lastDown.disabled).toBe(true);
    fireEvent.click(firstUp);
    fireEvent.click(lastDown);
    expect(preferences.move).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('section-layout-move-up-similarClimbs'));
    fireEvent.click(screen.getByTestId('section-layout-move-down-logbook'));
    expect(preferences.move.mock.calls).toEqual([
      ['similarClimbs', -1],
      ['logbook', 1],
    ]);
  });

  it('names each arrow after its section and says where a moved section landed', () => {
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const moveUp = screen.getByTestId('section-layout-move-up-community');
    expect(moveUp.getAttribute('aria-label')).toBe(
      'mobile.settings.sectionLayout.moveUp {"section":"mobile.settings.climbDrawer.sections.community"}',
    );
    fireEvent.click(moveUp);
    expect(accessibility.announce).toHaveBeenCalledWith(
      'mobile.settings.sectionLayout.moved {"section":"mobile.settings.climbDrawer.sections.community","position":5,"count":7}',
    );
  });

  it('offers Restore defaults under the list only once something differs from the defaults', () => {
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const restore = screen.getByTestId('play-drawer-sections-restore-defaults') as HTMLButtonElement;
    expect(restore.closest('footer')).toBeTruthy();
    expect(restore.disabled).toBe(true);
    preferences.order = ['logbook', 'setterNotes', 'climberLogs', ...DEFAULT_ORDER.slice(3)];
    screen.rerender(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    expect(preferences.restoreDefaults).toHaveBeenCalledTimes(1);
  });

  it('keeps the arrows and Restore defaults inert until preferences are ready', () => {
    preferences.ready = false;
    preferences.order = ['similarClimbs', ...DEFAULT_ORDER.slice(0, 6)];
    const screen = render(createElement(PlayDrawerSectionsSheet, { visible: true, onClose: vi.fn() }));
    const arrows = [...screen.container.querySelectorAll('[data-testid^="section-layout-move"]')];
    expect(arrows.every((arrow) => (arrow as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByTestId('play-drawer-sections-restore-defaults') as HTMLButtonElement).disabled).toBe(true);
  });
});
