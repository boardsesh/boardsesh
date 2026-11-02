import type { HomeSectionId } from '../../../lib/home-sections';
import type { StartupScreen } from '../../../settings';
import type { MoreFormModel, MoreOption } from '../../MoreForm.types';
import type { SectionLayoutRowModel } from '../../section-layout/SectionLayoutList';
import {
  movableFormRows,
  sectionLayoutToggleRow,
  type MovableFormRows,
} from '../../section-layout/section-layout-form-rows';
import type { SettingsTranslate } from '../root/settings-pages';

export type HomeSettingsModelInput = {
  t: SettingsTranslate;
  /** The tab an ordinary launch opens on (#6536). */
  startupScreen: StartupScreen;
  onStartupScreenChange: (screen: StartupScreen) => void;
  /**
   * How the sections that move draw (see section-layout-form-rows.ts): one hosted
   * React Native row on iOS and the browser, native switches with move buttons on
   * Android. The form has no reorderable row of its own.
   */
  movableSections: MovableFormRows<HomeSectionId>;
  /** The sections that keep their place (the feed, always last), as native switches. */
  fixedRows: readonly SectionLayoutRowModel<HomeSectionId>[];
  onSectionChange: (sectionId: HomeSectionId, visible: boolean) => void;
  canShowAll: boolean;
  onShowAll: () => void;
  canApplyFocused: boolean;
  onApplyFocused: () => void;
  canRestoreDefaults: boolean;
  onRestoreDefaults: () => void;
};

/**
 * Settings › Home, on the native form like Board and Climbs & grades: whether
 * the app opens on Climbs or Home; the sections with their switches and ↑/↓
 * arrows (the one React Native row, #6480's exception, at Marco's ask; on
 * Android native switches with native arrow buttons instead); the feed, which stays
 * last; then Show all, Focused and Restore defaults.
 */
export function buildHomeSettingsModel(input: HomeSettingsModelInput): MoreFormModel {
  const { t } = input;
  const sectionToggle = (row: SectionLayoutRowModel<HomeSectionId>) =>
    sectionLayoutToggleRow(row, input.onSectionChange);
  // Disabled at the ends: the first can't go up, the last can't pass the feed.
  const movableRows = movableFormRows(t, input.movableSections, input.onSectionChange, { key: 'movableSections' });
  // The tab names, so the choice reads exactly like the tab bar. Climbs first:
  // it is the default.
  const startupOptions: (MoreOption & { key: StartupScreen })[] = [
    { key: 'climbs', label: t('mobile.nav.climbs') },
    { key: 'home', label: t('mobile.nav.home') },
  ];
  return {
    sections: [
      {
        // Changing it never navigates: the footer says when it takes effect,
        // and what still opens somewhere else.
        key: 'startup',
        title: t('mobile.settings.startup.title'),
        footer: t('mobile.settings.startup.footer'),
        rows: [
          {
            kind: 'segmented',
            key: 'startupScreen',
            label: t('mobile.settings.startup.title'),
            options: startupOptions,
            selectedKey: input.startupScreen,
            onSelect: (key) => {
              const next = startupOptions.find((option) => option.key === key);
              if (next) input.onStartupScreenChange(next.key);
            },
          },
        ],
      },
      {
        key: 'sections',
        title: t('mobile.settings.homeSections.groupTitle'),
        rows: movableRows,
      },
      {
        key: 'fixedSections',
        footer: t('mobile.settings.homeSections.settingsFooter'),
        rows: input.fixedRows.map(sectionToggle),
      },
      {
        key: 'presets',
        footer: t('mobile.settings.homeSections.footer'),
        rows: [
          {
            kind: 'button',
            key: 'showAll',
            label: t('mobile.settings.homeSections.showAll'),
            disabled: !input.canShowAll,
            onPress: input.onShowAll,
          },
          {
            kind: 'button',
            key: 'focused',
            label: t('mobile.settings.homeSections.focused'),
            disabled: !input.canApplyFocused,
            onPress: input.onApplyFocused,
          },
          {
            kind: 'button',
            key: 'restoreDefaults',
            label: t('mobile.settings.homeSections.restoreDefaults'),
            disabled: !input.canRestoreDefaults,
            onPress: input.onRestoreDefaults,
          },
        ],
      },
    ],
  };
}
