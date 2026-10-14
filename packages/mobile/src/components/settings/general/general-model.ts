import type { ThemeOverride } from '@boardsesh/key-value-storage';
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '@boardsesh/i18n';
import type { LocaleOverride } from '../../../lib/i18n/locale-preference';
import type { MoreFormModel, MoreOption } from '../../MoreForm.types';
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
  onReplayWalkthrough: () => void;
  onReplayBoardLook: () => void;
};

/**
 * "General": how the app looks and reads, and the two walkthroughs you can run
 * again.
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
