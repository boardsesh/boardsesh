import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../src/providers/theme-provider';
import { DevMetadataPanel } from '../../../src/components/DevMetadataPanel';
import { Icon } from '../../../src/components/Icon';
import { ListRow } from '../../../src/components/ListRow';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { isPreviewBuild } from '../../../src/lib/eas-api';

export default function MoreScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const { t } = useTranslation('common');

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      <DevMetadataPanel />
      {__DEV__ ? (
        <View style={styles.section}>
          <SectionHeader title={t('mobile.more.development')} />
          <View
            style={[
              styles.card,
              {
                backgroundColor: systemColors.secondaryBackground,
                borderRadius: borderRadius.lg,
                marginHorizontal: spacing[4],
              },
            ]}
          >
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
            onPress={() => router.push('/(tabs)/more/branch-switcher')}
          />
        </>
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
  card: {
    overflow: 'hidden',
  },
});
