import { router } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Constants from 'expo-constants';
import { useTheme } from '../../../src/providers/theme-provider';
import { useAuth } from '../../../src/providers/auth-provider';
import { useSetting } from '../../../src/settings';
import { DevMetadataPanel } from '../../../src/components/DevMetadataPanel';
import { Icon } from '../../../src/components/Icon';
import { ListRow } from '../../../src/components/ListRow';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { Text } from '../../../src/components/Text';
import { isPreviewBuild } from '../../../src/lib/eas-api';

type ToggleSettingKey =
  | 'autoConnectBle'
  | 'keepScreenAwake'
  | 'hapticFeedbackEnabled'
  | 'notifySessionInvites'
  | 'notifyClimbComments';

function ToggleRow({ title, settingsKey }: { title: string; settingsKey: ToggleSettingKey }) {
  const [value, setValue] = useSetting(settingsKey);
  const { brandColors } = useTheme();

  return (
    <ListRow
      title={title}
      trailing={<Switch value={value} onValueChange={setValue} trackColor={{ true: brandColors.tint }} />}
      haptic={false}
    />
  );
}

type ThemeOption = 'system' | 'light' | 'dark';

function ThemePicker() {
  const { t } = useTranslation('common');
  const { brandColors } = useTheme();
  const [theme, setTheme] = useSetting('theme');

  const options: { value: ThemeOption; label: string }[] = [
    { value: 'system', label: t('mobile.settings.themeSystem') },
    { value: 'light', label: t('mobile.settings.themeLight') },
    { value: 'dark', label: t('mobile.settings.themeDark') },
  ];

  return (
    <>
      {options.map((option, index) => (
        <ListRow
          key={option.value}
          title={option.label}
          onPress={() => setTheme(option.value)}
          showSeparator={index < options.length - 1}
          trailing={theme === option.value ? <Icon name="check.small" size={18} color={brandColors.tint} /> : undefined}
        />
      ))}
    </>
  );
}

export default function MoreScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const { signOut } = useAuth();
  const { t } = useTranslation('common');

  const appVersion = Constants.expoConfig?.version ?? '2.0.0';

  const handleSignOut = () => {
    Alert.alert(t('mobile.settings.signOutConfirmTitle'), t('mobile.settings.signOutConfirmMessage'), [
      { text: t('mobile.settings.cancel'), style: 'cancel' },
      { text: t('mobile.settings.signOut'), style: 'destructive', onPress: signOut },
    ]);
  };

  const cardStyle = {
    backgroundColor: systemColors.secondaryBackground,
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
    overflow: 'hidden' as const,
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      <DevMetadataPanel />

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.sessionSection')} />
        <View style={cardStyle}>
          <ToggleRow title={t('mobile.settings.autoConnectBle')} settingsKey="autoConnectBle" />
          <ToggleRow title={t('mobile.settings.keepScreenAwake')} settingsKey="keepScreenAwake" />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.notificationsSection')} />
        <View style={cardStyle}>
          <ToggleRow title={t('mobile.settings.sessionInvites')} settingsKey="notifySessionInvites" />
          <ToggleRow title={t('mobile.settings.climbComments')} settingsKey="notifyClimbComments" />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.appearanceSection')} />
        <View style={cardStyle}>
          <ToggleRow title={t('mobile.settings.hapticFeedback')} settingsKey="hapticFeedbackEnabled" />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.themeSection')} />
        <View style={cardStyle}>
          <ThemePicker />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.accountSection')} />
        <View style={cardStyle}>
          <ListRow title={t('mobile.settings.signOut')} onPress={handleSignOut} showSeparator={false} />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.settings.aboutSection')} />
        <View style={cardStyle}>
          <ListRow
            title={t('mobile.settings.version')}
            trailing={
              <Text variant="body" style={{ color: systemColors.secondaryLabel }}>
                {appVersion}
              </Text>
            }
            showSeparator={false}
            haptic={false}
          />
        </View>
      </View>

      {__DEV__ ? (
        <View style={styles.section}>
          <SectionHeader title={t('mobile.more.development')} />
          <View style={cardStyle}>
            <ListRow
              title={t('mobile.more.metroServersTitle')}
              subtitle={t('mobile.more.metroServersSubtitle')}
              leading={<Icon name="server" size={22} color={systemColors.secondaryLabel} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/more/dev-servers')}
            />
          </View>
        </View>
      ) : null}

      {isPreviewBuild() ? (
        <View style={styles.section}>
          {/* i18n-ignore-next-line — preview-only section */}
          <SectionHeader title="Preview Build" />
          <View style={cardStyle}>
            <ListRow
              // i18n-ignore-next-line
              title="Branch Switcher"
              // i18n-ignore-next-line
              subtitle="Switch EAS Update branch"
              leading={<Icon name="branch" size={22} color={systemColors.label} />}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/(tabs)/more/branch-switcher')}
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingTop: 16,
    paddingBottom: 32,
  },
  section: {
    width: '100%',
    marginBottom: 24,
  },
});
