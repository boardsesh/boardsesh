import type { ThemeOverride } from '@boardsesh/key-value-storage';
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '@boardsesh/i18n';
import type { LocaleOverride } from '../../../lib/i18n/locale-preference';
import type { MoreFormModel, MoreOption, MoreRow, MoreSection, MoreToggleRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

export type GeneralModelInput = {
  t: SettingsTranslate;
  appearance: ThemeOverride;
  onAppearanceChange: (appearance: ThemeOverride) => void;
  language: LocaleOverride;
  onLanguageChange: (language: LocaleOverride) => void;
  /** The language the app is showing now ('system' resolved), for the Help translate footer. */
  activeLocale: Locale;
  onHelpTranslate: () => void;
  /** What the phone keeps for when there's no signal. */
  offline: GeneralOfflineInput;
  onReplayWalkthrough: () => void;
  onReplayBoardLook: () => void;
};

export type GeneralOfflineInput = {
  /**
   * The offline-downloads switch for this build. Off hides the offline
   * switches; the Storage row has its own rule (`showStorage`).
   */
  offlineEnabled: boolean;
  /** The "Offline mode" switch, or `null` where it can do nothing (Expo web). */
  offlineModeRow: MoreToggleRow | null;
  autoOfflineBoards: boolean;
  onAutoOfflineBoardsChange: (enabled: boolean) => void;
  /** Writes still in the outbox. */
  pendingCount: number;
  /** Nothing is going out right now: no signal, server unreachable, or Offline mode. */
  effectiveOffline: boolean;
  showStorage: boolean;
  onOpenStorage: () => void;
};

/**
 * The Offline section: the switch that stops every request, keeping boards on
 * the phone, and what those downloads take up.
 *
 * Each half has its own rule, and the section shows whichever apply, under one
 * "Offline" title that sits on whichever group comes first. With neither, there
 * is no section at all.
 */
function buildGeneralOfflineSections(t: SettingsTranslate, input: GeneralOfflineInput): MoreSection[] {
  const sections: MoreSection[] = [];

  if (input.offlineEnabled) {
    const rows: MoreRow[] = [];
    // First, because it decides whether anything below it can reach the network
    // at all.
    //
    // It sits inside the `offlineEnabled` gate with the rest of the section.
    // That gate is a constant today, but if it ever went false with the mode
    // ON, the climber is not stranded: the connectivity banner is up the whole
    // time offline mode is on, and its "Go online" turns it back off.
    if (input.offlineModeRow) rows.push(input.offlineModeRow);
    rows.push({
      kind: 'toggle',
      key: 'autoOfflineBoards',
      label: t('mobile.settings.offline.autoDownload'),
      subtitle: t('mobile.settings.offline.autoDownloadDescription'),
      value: input.autoOfflineBoards,
      onValueChange: input.onAutoOfflineBoardsChange,
    });
    sections.push({
      key: 'offline',
      // The two things a climber who just logged a send with no signal wants to
      // know: that it is not lost, and that it goes out by itself. Online with
      // work still queued, the same line becomes a live "sending it now".
      footer:
        input.pendingCount === 0
          ? undefined
          : input.effectiveOffline
            ? t('mobile.settings.offline.pendingFooter', { count: input.pendingCount })
            : t('mobile.settings.offline.syncingFooter', { count: input.pendingCount }),
      rows,
    });
  }

  if (input.showStorage) {
    sections.push({
      key: 'storage',
      footer: t('mobile.settings.storage.rowSubtitle'),
      rows: [
        {
          kind: 'nav',
          key: 'storage',
          label: t('mobile.settings.storage.title'),
          icon: 'storage',
          onPress: input.onOpenStorage,
        },
      ],
    });
  }

  const [first, ...rest] = sections;
  return first ? [{ ...first, title: t('mobile.settings.offline.title') }, ...rest] : [];
}

/**
 * "General": how the app looks and reads, what it keeps for when there's no
 * signal, and the two walkthroughs you can run again.
 */
export function buildGeneralModel(input: GeneralModelInput): MoreFormModel {
  const { t } = input;

  const appearanceOptions: (MoreOption & { key: ThemeOverride })[] = [
    { key: 'system', label: t('mobile.settings.appearance.system') },
    { key: 'light', label: t('mobile.settings.appearance.light') },
    { key: 'dark', label: t('mobile.settings.appearance.dark') },
  ];

  // 'System' follows the device language; the rest are the supported locales,
  // labelled in their own script (English / Español / Français) from
  // LOCALE_LABELS. Language names are intentionally not translated.
  const languageOptions: (MoreOption & { key: LocaleOverride })[] = [
    { key: 'system', label: t('mobile.settings.language.system') },
    ...SUPPORTED_LOCALES.map((locale) => ({ key: locale, label: LOCALE_LABELS[locale] })),
  ];

  return {
    sections: [
      {
        key: 'appearance',
        title: t('mobile.settings.appearance.title'),
        rows: [
          {
            kind: 'segmented',
            key: 'appearance',
            label: t('mobile.settings.appearance.title'),
            options: appearanceOptions,
            selectedKey: input.appearance,
            onSelect: (key) => {
              const next = appearanceOptions.find((option) => option.key === key);
              if (next) input.onAppearanceChange(next.key);
            },
          },
        ],
      },
      {
        // The picker's own label carries the word "Language", so no section title.
        key: 'language',
        footer: t('mobile.settings.language.description'),
        rows: [
          {
            kind: 'select',
            key: 'language',
            label: t('mobile.settings.language.title'),
            options: languageOptions,
            selectedKey: input.language,
            onSelect: (key) => {
              const next = languageOptions.find((option) => option.key === key);
              if (next) input.onLanguageChange(next.key);
            },
          },
        ],
      },
      {
        key: 'languageContribute',
        footer: t('mobile.settings.language.contributeSubtitle', { language: LOCALE_LABELS[input.activeLocale] }),
        rows: [
          {
            kind: 'nav',
            key: 'helpTranslate',
            label: t('mobile.settings.language.contributeTitle'),
            icon: 'translate',
            // Opens the catalog on GitHub, outside the app.
            external: true,
            onPress: input.onHelpTranslate,
          },
        ],
      },
      ...buildGeneralOfflineSections(t, input.offline),
      {
        // Buttons, not nav rows: both open a full-screen walkthrough over
        // Settings rather than a page inside it, so a chevron would mislead.
        key: 'replay',
        title: t('mobile.onboarding.replaySection'),
        rows: [
          {
            kind: 'button',
            key: 'replay',
            label: t('mobile.onboarding.replayTitle'),
            onPress: input.onReplayWalkthrough,
          },
        ],
      },
      {
        // Its own group, so the footer that explains it sits under this button
        // alone rather than under both.
        key: 'replayBoardLook',
        footer: t('mobile.settings.boardLook.intro.replaySubtitle'),
        rows: [
          {
            kind: 'button',
            key: 'replay-board-look',
            label: t('mobile.settings.boardLook.intro.replayTitle'),
            onPress: input.onReplayBoardLook,
          },
        ],
      },
    ],
  };
}
