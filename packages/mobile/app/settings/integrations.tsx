import type { ComponentType } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SectionHeader } from '../../src/components/SectionHeader';
import { ListRow } from '../../src/components/ListRow';
import { BoardAccountsSection } from '../../src/components/integrations/BoardAccountsSection';
import { AppleHealthCard } from '../../src/components/integrations/AppleHealthCard';
import { StravaCard } from '../../src/components/integrations/StravaCard';
import { getSupportedIntegrations, type IntegrationId } from '../../src/lib/integrations';
import { scopedRouter as router } from '../../src/lib/routing/scoped-navigation';
import { useFeatureFlag } from '../../src/providers/feature-flags-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { borderRadius, spacing } from '../../src/theme/tokens';

// One card per supported integration. The registry decides which integrations
// are available on this platform; this lookup maps each id to its UI.
const INTEGRATION_CARDS: Record<IntegrationId, ComponentType> = {
  'apple-health': AppleHealthCard,
  strava: StravaCard,
};

export default function IntegrationsScreen() {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const stravaEnabled = useFeatureFlag('strava-integration') === true;
  // Pairing a Garmin watch used to be its own row on the Settings root. It is a
  // connected device like the apps below, so it lives here now.
  const garminWatchEnabled = useFeatureFlag('garmin-watch') === true;
  const integrations = getSupportedIntegrations().filter((integration) => integration.id !== 'strava' || stravaEnabled);

  // Per-id card title. A static switch (not a dynamic `t(integration.titleKey)`)
  // so the i18n checker can see every concrete key — adding an integration adds
  // a case here alongside its INTEGRATION_CARDS entry.
  const titleFor = (id: IntegrationId): string => {
    switch (id) {
      case 'apple-health':
        return t('integrations.appleHealth.title');
      case 'strava':
        return t('integrations.strava.title');
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: systemColors.groupedBackground }}
      contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding + spacing[4] }]}
    >
      <BoardAccountsSection />
      {integrations.map((integration) => {
        const Card = INTEGRATION_CARDS[integration.id];
        return (
          <View key={integration.id} style={styles.section}>
            <SectionHeader title={titleFor(integration.id)} />
            <Card />
          </View>
        );
      })}
      {garminWatchEnabled ? (
        <View style={styles.section}>
          <SectionHeader title={t('integrations.garmin.title')} />
          <View style={[styles.card, { backgroundColor: systemColors.secondaryGroupedBackground }]}>
            <ListRow
              title={t('watchPairing.title')}
              showChevron
              showSeparator={false}
              onPress={() => router.push('/settings/watch-pair')}
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    maxWidth: 672,
    alignSelf: 'center',
    flexGrow: 1,
    paddingTop: spacing[4],
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
});
