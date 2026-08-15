import { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { LeaderboardVisibility } from '@boardsesh/shared-schema';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useProfile, useUpdateProfile } from '../../lib/graphql/hooks';
import { borderRadius, spacing } from '../../theme/tokens';

/**
 * Two independent consent settings, one per audience.
 *
 * They are separate columns rather than one because being named on a screen
 * hanging in the gym you are standing in is a different decision from being
 * named in an app a stranger can open. Collapsing them into one control would
 * force climbers to answer the stricter question for both.
 */
const VISIBILITY_OPTIONS: LeaderboardVisibility[] = ['public', 'anonymous', 'off'];

function optionLabel(t: TFunction<'settings'>, value: LeaderboardVisibility): string {
  switch (value) {
    case 'public':
      return t('standings.options.public.title');
    case 'anonymous':
      return t('standings.options.anonymous.title');
    case 'off':
      return t('standings.options.off.title');
  }
}

function optionSubtitle(t: TFunction<'settings'>, value: LeaderboardVisibility): string {
  switch (value) {
    case 'public':
      return t('standings.options.public.subtitle');
    case 'anonymous':
      return t('standings.options.anonymous.subtitle');
    case 'off':
      return t('standings.options.off.subtitle');
  }
}

type VisibilityChoiceProps = {
  sectionTitle: string;
  description: string;
  selected: LeaderboardVisibility;
  disabled: boolean;
  onSelect: (value: LeaderboardVisibility) => void;
};

function VisibilityChoice({ sectionTitle, description, selected, disabled, onSelect }: VisibilityChoiceProps) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();

  return (
    <View style={styles.section}>
      <SectionHeader title={sectionTitle} />
      <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
        {VISIBILITY_OPTIONS.map((value, index) => {
          const isSelected = value === selected;
          return (
            <ListRow
              key={value}
              title={optionLabel(t, value)}
              subtitle={optionSubtitle(t, value)}
              // A checkmark on the chosen row, matching the rest of settings.
              // `accessibilityState.selected` is what carries the choice to a
              // screen reader — the icon alone is invisible to it.
              trailing={isSelected ? <Icon name="check.small" size={20} color={systemColors.accent} /> : undefined}
              showSeparator={index < VISIBILITY_OPTIONS.length - 1}
              onPress={disabled ? undefined : () => onSelect(value)}
              accessibilityLabel={optionLabel(t, value)}
              accessibilityHint={optionSubtitle(t, value)}
            />
          );
        })}
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
        {description}
      </Text>
    </View>
  );
}

export function StandingsPrivacyScreen() {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();

  // Optimistic read: while a write is in flight, show what was tapped rather
  // than the stale server value, so the checkmark does not jump back and forth.
  const pending = updateProfile.isPending ? updateProfile.variables : undefined;
  const leaderboardVisibility: LeaderboardVisibility =
    pending?.leaderboardVisibility ?? profile?.leaderboardVisibility ?? 'public';
  const gymScreenVisibility: LeaderboardVisibility =
    pending?.gymScreenVisibility ?? profile?.gymScreenVisibility ?? 'public';

  const handleSelectLeaderboard = useCallback(
    (value: LeaderboardVisibility) => {
      if (value === leaderboardVisibility) return;
      // Send only the field that changed — the two settings are independent and
      // sending both would let a stale read of one overwrite a fresh write.
      updateProfile.mutate({ leaderboardVisibility: value });
    },
    [leaderboardVisibility, updateProfile],
  );

  const handleSelectGymScreen = useCallback(
    (value: LeaderboardVisibility) => {
      if (value === gymScreenVisibility) return;
      updateProfile.mutate({ gymScreenVisibility: value });
    },
    [gymScreenVisibility, updateProfile],
  );

  const contentContainerStyle = useMemo(
    () => [styles.scrollContent, { paddingBottom: scrollBottomPadding + spacing[4] }],
    [scrollBottomPadding],
  );

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={contentContainerStyle}>
      <View style={styles.intro}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
          {t('standings.intro')}
        </Text>
      </View>

      <VisibilityChoice
        sectionTitle={t('standings.inApp.title')}
        description={t('standings.inApp.description')}
        selected={leaderboardVisibility}
        disabled={updateProfile.isPending}
        onSelect={handleSelectLeaderboard}
      />

      <VisibilityChoice
        sectionTitle={t('standings.gymScreens.title')}
        description={t('standings.gymScreens.description')}
        selected={gymScreenVisibility}
        disabled={updateProfile.isPending}
        onSelect={handleSelectGymScreen}
      />

      {updateProfile.isError ? (
        <View style={styles.intro}>
          <Text variant="footnote" color={iosSystemColors.systemRed}>
            {t('standings.saveFailed')}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    paddingTop: spacing[4],
    gap: spacing[6],
  },
  intro: {
    paddingHorizontal: spacing[4],
  },
  section: {
    gap: spacing[2],
  },
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginHorizontal: spacing[4],
  },
  description: {
    lineHeight: 18,
    paddingHorizontal: spacing[4],
  },
});
