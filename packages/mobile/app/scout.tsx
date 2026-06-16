import { Stack } from 'expo-router';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ScoutPhoto } from '../src/components/ScoutPhoto';
import { Text } from '../src/components/Text';
import { useBottomChromeMetrics } from '../src/hooks/use-bottom-chrome-metrics';
import { dogName } from '../src/lib/acknowledgements';
import { useTheme } from '../src/providers/theme-provider';
import { useVariantValue } from '../src/theme/variants';
import { borderRadius, spacing } from '../src/theme/tokens';

export default function ScoutScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  // The transparent, blur-under-content header is an iOS-only feature (headerBlurEffect):
  // on iOS, Liquid Glass gets it and Material's opaque M3 app bar does not. On Android
  // — including a forced Liquid Glass user, where there's no glass surface — keep the
  // header opaque so scroll content doesn't slide under the status bar (dual-axis:
  // aesthetic AND platform). The hook is called unconditionally; only the value is gated.
  const prefersGlassHeader = useVariantValue({ liquidGlass: true, material: false });
  const headerTransparent = Platform.OS === 'ios' && prefersGlassHeader;

  return (
    <>
      <Stack.Screen
        options={{
          title: dogName,
          headerShown: true,
          headerLargeTitle: false,
          headerTransparent,
          headerBlurEffect: 'systemMaterial',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
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
