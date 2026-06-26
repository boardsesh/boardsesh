import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import * as Updates from 'expo-updates';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import type { ThemeOverride, UiVariantPreference } from '@boardsesh/key-value-storage';
import { SUPPORTED_LOCALES, LOCALE_LABELS } from '@boardsesh/i18n';
import { useTheme } from '../../../src/providers/theme-provider';
import { useLocalePreference } from '../../../src/providers/i18n-provider';
import { resolveLanguage, type LocaleOverride } from '../../../src/lib/i18n/locale-preference';
import { openExternalUrl } from '../../../src/lib/open-url';
import { useAuth } from '../../../src/providers/auth-provider';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { borderRadius, spacing } from '../../../src/theme/tokens';
import { DevMetadataPanel } from '../../../src/components/DevMetadataPanel';
import { Icon } from '../../../src/components/Icon';
import { Avatar } from '../../../src/components/Avatar';
import { Text } from '../../../src/components/Text';
import { ListRow } from '../../../src/components/ListRow';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { SessionRecordingSwitchRow } from '../../../src/components/settings/SessionRecordingSwitchRow';
import { isPreviewBuild } from '../../../src/lib/eas-api';
import { isDevLauncherAvailable } from '../../../src/lib/dev-launcher';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useGlassCapability } from '../../../src/hooks/use-glass-capability';
import { useToast } from '../../../src/providers/toast-provider';
import { useFeatureFlag } from '../../../src/providers/feature-flags-provider';
import { replayOnboarding } from '../../../src/lib/onboarding/onboarding-storage';
import { reportError } from '../../../src/lib/error-reporting';
import { latestEntryDate } from '../../../src/lib/changelog';
import { getLastSeenChangelogDate, hasUnseenChangelog } from '../../../src/lib/changelog-seen';

// Translations live in the shared catalog at packages/shared/i18n/locales/<locale>/.
// We deep-link to the active language's folder so a community member lands on the
// exact files to edit.
const GITHUB_LOCALES_TREE_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';

export default function MoreScreen() {
  const { systemColors, brandColors, themeOverride, setThemeOverride, uiVariantPreference, setUiVariant } = useTheme();
  const { t } = useTranslation('common');
  const { t: tProfile } = useTranslation('profile');
  const { t: tPlaylists } = useTranslation('playlists');
  const { t: tSettings } = useTranslation('settings');
  const { signOut } = useAuth();
  const { data: profile } = useProfile();
  const { gradeFormat, setGradeFormat } = useGradeFormat();
  const glassCapable = useGlassCapability();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { showToast } = useToast();
  const stravaEnabled = useFeatureFlag('strava-integration') === true;

  // The OTA channel switcher relies on expo-updates runtime overrides, which only
  // work on real (non-dev) builds where updates are enabled. Gated on the tester
  // flag so only admin-marked testers see it.
  const showChannelSwitcher = Boolean(profile?.isTester) && !__DEV__ && Updates.isEnabled;

  // Live Metro dev-server switching needs expo-dev-client's native launcher, which
  // is only linked into dev-client / Debug builds — never the App Store / TestFlight
  // binary (where it would throw "Dev launcher unavailable"). Show the row only where
  // it can actually work; testers on a release build get the OTA channel switcher.
  const showDevServerSwitcher = isDevLauncherAvailable();

  // Feature-flag overrides work in every build (dev forces them in place of the
  // disabled PostHog read; release builds layer them on top), so show the entry
  // wherever the dev section is allowed — for testers and in dev.
  const showFeatureFlags = __DEV__ || Boolean(profile?.isTester);

  // Don't render an empty "Development" section header when no tool applies
  // (e.g. a tester on a release build with updates disabled).
  const showDevSection =
    (__DEV__ || Boolean(profile?.isTester)) && (showDevServerSwitcher || showChannelSwitcher || showFeatureFlags);

  // Whether the bundled changelog has an entry the user hasn't opened yet — drives
  // the "New" pill on the What's New row. Re-read every time this screen regains
  // focus: opening the changelog clears the flag, but a native-stack push leaves
  // More mounted underneath, so a mount-only read would never see the cleared
  // state when the user pops back.
  const [changelogUnseen, setChangelogUnseen] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void getLastSeenChangelogDate().then((lastSeen) => {
        if (active) setChangelogUnseen(hasUnseenChangelog(latestEntryDate, lastSeen));
      });
      return () => {
        active = false;
      };
    }, []),
  );

  // 'System' follows the device language; the rest are the supported locales,
  // labelled in their own script (English / Español / Français) from
  // LOCALE_LABELS — language names are intentionally not translated.
  const languageOptions: { key: LocaleOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.language.system') },
    ...SUPPORTED_LOCALES.map((locale) => ({ key: locale, label: LOCALE_LABELS[locale] })),
  ];

  // The community keeps the es/fr translations current; deep-link the CTA to the
  // folder for whatever language the app is currently showing ('system' resolves
  // to the device locale).
  const activeLocale = resolveLanguage(localePreference);
  const handleHelpTranslate = () => {
    void openExternalUrl(`${GITHUB_LOCALES_TREE_URL}/${activeLocale}`, 'more-help-translate');
  };

  const appearanceOptions: { key: ThemeOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.appearance.system') },
    { key: 'light', label: t('mobile.more.appearance.light') },
    { key: 'dark', label: t('mobile.more.appearance.dark') },
  ];

  const uiStyleOptions: { key: UiVariantPreference; label: string }[] = [
    { key: 'auto', label: t('mobile.more.uiStyle.auto') },
    { key: 'liquidGlass', label: t('mobile.more.uiStyle.liquidGlass') },
    { key: 'material', label: t('mobile.more.uiStyle.material') },
  ];
  // Hint copy: capable iPhones explain the Auto behaviour; older iPhones get the
  // iOS-26 upgrade note; Android gets a glass-fallback note without the (irrelevant)
  // iOS-26 reference.
  const uiStyleHint = glassCapable
    ? t('mobile.more.uiStyle.description')
    : Platform.OS === 'ios'
      ? t('mobile.more.uiStyle.glassFallback')
      : t('mobile.more.uiStyle.glassFallbackAndroid');

  const gradeFormatOptions: { key: GradeDisplayFormat; label: string }[] = [
    { key: 'v-grade', label: t('mobile.more.gradeFormat.vGrade') },
    { key: 'font', label: t('mobile.more.gradeFormat.font') },
    { key: 'both', label: t('mobile.more.gradeFormat.both') },
  ];

  const handleReplayWalkthrough = () => {
    // Clear the "seen" flag BEFORE opening the tour (the await is inside
    // replayOnboarding). Ordering matters: if the replayed tour is
    // finished/skipped before the clear settles, markOnboardingSeen() could land
    // first and a late clear would wipe the flag — leaving the tour "unseen" and
    // re-showing on the next cold start.
    //
    // If the SecureStore clear rejects (keychain locked / unavailable),
    // replayOnboarding never navigates, so surface an error toast instead of the
    // row silently doing nothing. Log + report so we notice a recurring failure.
    replayOnboarding(() => router.push('/onboarding')).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[onboarding] Failed to replay walkthrough', error);
      reportError(error);
      showToast(t('mobile.onboarding.replayError'), 'error');
    });
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      <DevMetadataPanel />

      {profile?.id ? (
        <View style={styles.section}>
          <SectionHeader title={t('mobile.more.library')} />
          <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            <ListRow
              title={tPlaylists('library.allPlaylists.title')}
              leading={<Icon name="playlist" size={22} color={systemColors.secondaryLabel} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/discover/all')}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.integrations.title')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <ListRow
            title={t('mobile.more.integrations.title')}
            subtitle={t(
              stravaEnabled ? 'mobile.more.integrations.subtitleWithStrava' : 'mobile.more.integrations.subtitle',
            )}
            leading={<Icon name="favorite" size={22} color={systemColors.secondaryLabel} />}
            showChevron
            showSeparator={false}
            onPress={() => router.push('/(tabs)/profile/integrations')}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.appearance.title')} />
        <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
          <SegmentedControl
            options={appearanceOptions}
            selectedKey={themeOverride}
            onSelect={(key) => void setThemeOverride(key)}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.more.appearance.title')}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.uiStyle.title')} />
        <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
          <SegmentedControl
            options={uiStyleOptions}
            selectedKey={uiVariantPreference}
            onSelect={(key) => void setUiVariant(key)}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.more.uiStyle.title')}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.settingHint}>
            {uiStyleHint}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.gradeFormat.title')} />
        <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
          <SegmentedControl
            options={gradeFormatOptions}
            selectedKey={gradeFormat}
            onSelect={setGradeFormat}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.more.gradeFormat.title')}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.settingHint}>
            {t('mobile.more.gradeFormat.description')}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.accessibility.title')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <ListRow
            title={t('mobile.more.accessibility.title')}
            subtitle={t('mobile.more.accessibility.rowSubtitleShort')}
            leading={<Icon name="visibility" size={22} color={systemColors.secondaryLabel} />}
            showChevron
            showSeparator={false}
            onPress={() => router.push('/(tabs)/profile/accessibility')}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.language.title')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          {languageOptions.map((option, index) => (
            <ListRow
              key={option.key}
              title={option.label}
              trailing={
                localePreference === option.key ? (
                  <Icon name="check.small" size={20} color={systemColors.accent} />
                ) : undefined
              }
              showSeparator={index < languageOptions.length - 1}
              onPress={() => setLocalePreference(option.key)}
            />
          ))}
        </View>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.languageHint}>
          {t('mobile.more.language.description')}
        </Text>
        <View style={[styles.card, styles.contributeCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <ListRow
            title={t('mobile.more.language.contributeTitle')}
            subtitle={t('mobile.more.language.contributeSubtitle', { language: LOCALE_LABELS[activeLocale] })}
            leading={<Icon name="github" size={22} color={systemColors.secondaryLabel} />}
            showChevron
            showSeparator={false}
            onPress={handleHelpTranslate}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.diagnostics.title')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <SessionRecordingSwitchRow
            label={t('mobile.more.diagnostics.recording')}
            description={t('mobile.more.diagnostics.recordingDescription')}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.onboarding.replaySection')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <ListRow
            title={t('mobile.onboarding.replayTitle')}
            subtitle={t('mobile.onboarding.replaySubtitle')}
            leading={<Icon name="play.circle" size={22} color={systemColors.secondaryLabel} />}
            showChevron
            showSeparator={false}
            onPress={handleReplayWalkthrough}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.aboutSection')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <ListRow
            title={t('mobile.more.changelogTitle')}
            subtitle={t('mobile.more.changelogSubtitle')}
            leading={<Icon name="flash" size={22} color={systemColors.secondaryLabel} />}
            trailing={
              changelogUnseen ? (
                <View style={[styles.newPill, { backgroundColor: brandColors.primaryFill }]}>
                  <Text variant="caption2" color={brandColors.onPrimary} style={styles.newPillLabel}>
                    {t('mobile.more.newPill')}
                  </Text>
                </View>
              ) : undefined
            }
            showChevron
            showSeparator={false}
            onPress={() => router.push('/changelog')}
          />
        </View>
      </View>

      {showDevSection ? (
        <View style={styles.section}>
          <SectionHeader title={t('mobile.more.development')} />
          <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            {showDevServerSwitcher ? (
              <ListRow
                title={t('mobile.more.metroServersTitle')}
                subtitle={t('mobile.more.metroServersSubtitle')}
                leading={<Icon name="server" size={22} color={systemColors.secondaryLabel} />}
                showChevron
                showSeparator={showChannelSwitcher || showFeatureFlags}
                onPress={() => router.push('/(tabs)/profile/dev-servers')}
              />
            ) : null}
            {showChannelSwitcher ? (
              <ListRow
                // i18n-ignore-next-line — tester-only dev tooling
                title="OTA Channel Switcher"
                // i18n-ignore-next-line
                subtitle="Switch Expo update channel"
                leading={<Icon name="transfer" size={22} color={systemColors.secondaryLabel} />}
                showChevron
                showSeparator={showFeatureFlags}
                onPress={() => router.push('/(tabs)/profile/channel-switcher')}
              />
            ) : null}
            {showFeatureFlags ? (
              <ListRow
                // i18n-ignore-next-line — tester-only dev tooling
                title="Feature Flags"
                // i18n-ignore-next-line
                subtitle="Force feature flags on or off"
                leading={<Icon name="flag" size={22} color={systemColors.secondaryLabel} />}
                showChevron
                showSeparator={false}
                onPress={() => router.push('/(tabs)/profile/feature-flags')}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {isPreviewBuild() ? (
        <>
          {/* i18n-ignore-next-line — preview-only section */}
          <SectionHeader title="Preview Build" />
          <ListRow
            // i18n-ignore-next-line
            title="Branch Switcher"
            // i18n-ignore-next-line
            subtitle="Switch EAS Update branch"
            leading={<Icon name="branch" size={22} color={systemColors.label} />}
            showChevron
            showSeparator={false}
            onPress={() => router.push('/(tabs)/profile/branch-switcher')}
          />
        </>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title={tProfile('mobile.account')} />
        {profile?.id ? (
          <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            <ListRow
              title={tSettings('profile.editAction')}
              leading={<Avatar uri={profile.avatarUrl} name={profile.displayName ?? profile.email ?? null} size={28} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/profile/edit')}
            />
          </View>
        ) : null}
        {profile?.email ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountEmail}>
            {profile.email}
          </Text>
        ) : null}
        <Pressable
          style={[styles.signOut, { borderColor: systemColors.separator }]}
          onPress={() => {
            void signOut();
          }}
          accessibilityRole="button"
        >
          <Text variant="body" color={brandColors.error}>
            {tProfile('mobile.signOut')}
          </Text>
        </Pressable>
        <Pressable
          style={styles.deleteAccount}
          onPress={() => router.push('/(tabs)/profile/delete-account')}
          accessibilityRole="button"
        >
          <Text variant="body" color={brandColors.error}>
            {tSettings('deleteAccount.button')}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
  },
  section: {
    width: '100%',
    marginBottom: spacing[6],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  cardPadded: {
    padding: spacing[3],
  },
  settingHint: {
    marginTop: spacing[2],
  },
  languageHint: {
    marginTop: spacing[2],
    paddingHorizontal: spacing[4],
  },
  contributeCard: {
    marginTop: spacing[3],
  },
  newPill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  newPillLabel: {
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  accountEmail: {
    paddingHorizontal: spacing[4],
    marginTop: spacing[3],
    marginBottom: spacing[3],
  },
  signOut: {
    alignItems: 'center',
    paddingVertical: spacing[3],
    marginHorizontal: spacing[4],
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Deliberately subordinate to Sign Out: a borderless red text link, not the
  // bordered button above. Sign Out is the routine action; account deletion is
  // rare and irreversible, so it reads as a quieter, secondary affordance rather
  // than competing for equal visual weight.
  deleteAccount: {
    alignItems: 'center',
    paddingVertical: spacing[3],
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
  },
});
