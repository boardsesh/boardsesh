import { Stack } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ScoutPhoto } from '../src/components/ScoutPhoto';
import { Text } from '../src/components/Text';
import { useBottomChromeMetrics } from '../src/hooks/use-bottom-chrome-metrics';
import { useStackScreenOptions } from '../src/hooks/use-stack-screen-options';
import { dogName } from '../src/lib/acknowledgements';
import { useTheme } from '../src/providers/theme-provider';
import { borderRadius, spacing } from '../src/theme/tokens';

export default function ScoutScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  // Variant-aware header from the shared hook: a transparent blur header on Liquid
  // Glass (iOS), an opaque M3 app bar on Material — including the forced-Material-
  // on-iOS / Android paths where a transparent header would slide content under the
  // status bar.
  const screenOptions = useStackScreenOptions();

  return (
    <>
      <Stack.Screen options={{ ...screenOptions, title: dogName, headerShown: true }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }]}
      >
        <ScoutPhoto style={styles.photo} />
        <View style={styles.text}>
          <Text variant="title2" style={styles.name}>
            {dogName}
          </Text>
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.body}>
            {t('mobile.acknowledgements.dogBody')}
          </Text>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[4],
  },
  photo: {
    width: '100%',
    aspectRatio: 3 / 5,
    borderRadius: borderRadius.xl,
  },
  text: {
    paddingHorizontal: spacing[1],
    gap: spacing[2],
  },
  name: {
    fontWeight: '800',
  },
  body: {
    lineHeight: 22,
  },
});
