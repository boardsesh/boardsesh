import type { LeaderboardVisibility, UserProfile } from '@boardsesh/shared-schema';
import type { MoreOption, MoreSection } from '../MoreForm.types';
import type { PrivacyTranslate } from './privacy-settings-changes';

export type StandingsPrivacySettings = Pick<UserProfile, 'leaderboardVisibility' | 'gymScreenVisibility'>;
export type StandingsVisibilityField = keyof StandingsPrivacySettings;
export const STANDINGS_ROW_KEYS = ['leaderboardVisibility', 'gymScreenVisibility'] as const;

export function isStandingsVisibility(choice: string): choice is LeaderboardVisibility {
  return choice === 'public' || choice === 'anonymous' || choice === 'off';
}

/** The app choice is a ceiling; a public API cannot authenticate a gym-screen surface. */
export function effectiveGymVisibility(settings: StandingsPrivacySettings): LeaderboardVisibility {
  if (settings.leaderboardVisibility === 'off' || settings.gymScreenVisibility === 'off') return 'off';
  if (settings.leaderboardVisibility === 'anonymous' || settings.gymScreenVisibility === 'anonymous')
    return 'anonymous';
  return 'public';
}

function visibilityDescription(choice: LeaderboardVisibility, t: PrivacyTranslate): string {
  switch (choice) {
    case 'public':
      return t('settings:standings.options.public.subtitle');
    case 'anonymous':
      return t('settings:standings.options.anonymous.subtitle');
    case 'off':
      return t('settings:standings.options.off.subtitle');
  }
}

export type StandingsPrivacyModelInput = {
  settings: StandingsPrivacySettings | null | undefined;
  loading: boolean;
  loadFailed: boolean;
  onRetry: () => void;
  onSelect: (field: StandingsVisibilityField, choice: string) => void;
};

/** Two native pickers inside Privacy, with one shared write lock for every privacy setting. */
export function buildStandingsPrivacySections(
  input: StandingsPrivacyModelInput,
  t: PrivacyTranslate,
  disabled: boolean,
): MoreSection[] {
  if (!input.settings) {
    if (!input.loading && !input.loadFailed) return [];
    return [
      {
        key: 'standings',
        title: t('settings:standings.title'),
        rows: input.loading
          ? [{ kind: 'value', key: 'standingsLoading', label: t('settings:privacy.loadingSettings'), busy: true }]
          : input.loadFailed
            ? [
                { kind: 'value', key: 'standingsLoadFailed', label: t('settings:privacy.loadSettingsFailed') },
                {
                  kind: 'button',
                  key: 'standingsRetry',
                  label: t('common:actions.retry'),
                  disabled,
                  onPress: input.onRetry,
                },
              ]
            : [],
      },
    ];
  }
  const options: MoreOption[] = [
    { key: 'public', label: t('settings:standings.options.public.title') },
    { key: 'anonymous', label: t('settings:standings.options.anonymous.title') },
    { key: 'off', label: t('settings:standings.options.off.title') },
  ];
  return [
    {
      key: 'standings',
      title: t('settings:standings.title'),
      footer: `${t('settings:standings.inApp.description')} ${visibilityDescription(input.settings.leaderboardVisibility, t)} ${t('settings:standings.privacyPrecedence')}`,
      rows: [
        {
          kind: 'select',
          key: 'leaderboardVisibility',
          label: t('settings:standings.inApp.title'),
          options,
          selectedKey: input.settings.leaderboardVisibility,
          disabled,
          onSelect: (choice) => input.onSelect('leaderboardVisibility', choice),
        },
      ],
    },
    {
      key: 'standingsGym',
      footer: `${t('settings:standings.gymScreens.description')} ${visibilityDescription(effectiveGymVisibility(input.settings), t)}`,
      rows: [
        {
          kind: 'select',
          key: 'gymScreenVisibility',
          label: t('settings:standings.gymScreens.title'),
          options,
          selectedKey: input.settings.gymScreenVisibility,
          disabled,
          onSelect: (choice) => input.onSelect('gymScreenVisibility', choice),
        },
      ],
    },
  ];
}
