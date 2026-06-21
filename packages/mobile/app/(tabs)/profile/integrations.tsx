import type { ComponentType } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { BoardAccountsSection } from '../../../src/components/integrations/BoardAccountsSection';
import { AppleHealthCard } from '../../../src/components/integrations/AppleHealthCard';
import { StravaCard } from '../../../src/components/integrations/StravaCard';
import { getSupportedIntegrations, type IntegrationId } from '../../../src/lib/integrations';
import { useFeatureFlag } from '../../../src/providers/feature-flags-provider';
import { spacing } from '../../../src/theme/tokens';

// One card per supported integration. The registry decides which integrations
// are available on this platform; this lookup maps each id to its UI.
const INTEGRATION_CARDS: Record<IntegrationId, ComponentType> = {
  'apple-health': AppleHealthCard,
  strava: StravaCard,
};

export default function IntegrationsScreen() {
  const { t } = useTranslation('settings');
  const stravaEnabled = useFeatureFlag('strava-integration') === true;
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
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
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
});
