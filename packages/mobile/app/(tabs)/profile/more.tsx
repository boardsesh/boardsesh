import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import type { ThemeOverride, UiVariantPreference } from '@boardsesh/key-value-storage';
import { SUPPORTED_LOCALES, LOCALE_LABELS } from '@boardsesh/i18n';
import { useTheme } from '../../../src/providers/theme-provider';
import { useLocalePreference } from '../../../src/providers/i18n-provider';
import type { LocaleOverride } from '../../../src/lib/i18n/locale-preference';
import { useAuth } from '../../../src/providers/auth-provider';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { borderRadius, spacing } from '../../../src/theme/tokens';
import { DevMetadataPanel } from '../../../src/components/DevMetadataPanel';
import { Icon } from '../../../src/components/Icon';
import { Text } from '../../../src/components/Text';
import { ListRow } from '../../../src/components/ListRow';
import { SwitchRow } from '../../../src/components/SwitchRow';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { useSessionRecordingPreference } from '../../../src/lib/session-recording-preference';
import { setSessionRecordingEnabled } from '../../../src/lib/analytics';
import { isPreviewBuild } from '../../../src/lib/eas-api';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useGlassCapability } from '../../../src/hooks/use-glass-capability';
import { useToast } from '../../../src/providers/toast-provider';
import { replayOnboarding } from '../../../src/lib/onboarding/onboarding-storage';
import { reportError } from '../../../src/lib/sentry';

export default function MoreScreen() {
  const { systemColors, brandColors, themeOverride, setThemeOverride, uiVariantPreference, setUiVariant } = useTheme();
  const { t } = useTranslation('common');
  const { t: tProfile } = useTranslation('profile');
  const { t: tPlaylists } = useTranslation('playlists');
  const { signOut } = useAuth();
  const { data: profile } = useProfile();
  const { gradeFormat, setGradeFormat } = useGradeFormat();
  const glassCapable = useGlassCapability();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { enabled: sessionRecordingEnabled, setEnabled: setSessionRecordingPreference } =
    useSessionRecordingPreference();
  const { showToast } = useToast();

  // 'System' follows the device language; the rest are the supported locales,
  // labelled in their own script (English / Español / Français) from
  // LOCALE_LABELS — language names are intentionally not translated.
  const languageOptions: { key: LocaleOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.language.system') },
    ...SUPPORTED_LOCALES.map((locale) => ({ key: locale, label: LOCALE_LABELS[locale] })),
  ];

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
  // Liquid Glass can't render on Android / iOS < 26, so show it disabled there
  // rather than hide it — more honest than a no-op control.
  const disabledUiStyles = glassCapable ? undefined : new Set<UiVariantPreference>(['liquidGlass']);

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
            disabledKeys={disabledUiStyles}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.more.uiStyle.title')}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.settingHint}>
            {glassCapable ? t('mobile.more.uiStyle.description') : t('mobile.more.uiStyle.glassUnavailable')}
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
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.diagnostics.title')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <SwitchRow
            label={t('mobile.more.diagnostics.recording')}
            description={t('mobile.more.diagnostics.recordingDescription')}
            value={sessionRecordingEnabled}
            onValueChange={(next) => {
              // Persist the choice and apply it live: start/stop the PostHog
              // recording immediately rather than waiting for the next launch.
              setSessionRecordingPreference(next);
              setSessionRecordingEnabled(next);
            }}
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

      {__DEV__ ? (
        <View style={styles.section}>
          <SectionHeader title={t('mobile.more.development')} />
          <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            <ListRow
              title={t('mobile.more.metroServersTitle')}
              subtitle={t('mobile.more.metroServersSubtitle')}
              leading={<Icon name="server" size={22} color={systemColors.secondaryLabel} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/profile/dev-servers')}
            />
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
        {profile?.email ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountEmail}>
            {profile.email}
          </Text>
        ) : null}
        <Pressable
          style={[styles.signOut, { borderColor: systemColors.separator }]}
          onPress={signOut}
          accessibilityRole="button"
        >
          <Text variant="body" color={brandColors.error}>
            {tProfile('mobile.signOut')}
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
  accountEmail: {
    paddingHorizontal: spacing[4],
    marginBottom: spacing[3],
  },
  signOut: {
    alignItems: 'center',
    paddingVertical: spacing[3],
    marginHorizontal: spacing[4],
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
