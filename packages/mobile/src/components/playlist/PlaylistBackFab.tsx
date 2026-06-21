import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '../GlassIconButton';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * Floating glass back chevron for the playlist screens, which hide the native
 * header. The detail list renders its own back FAB inside the top bar; this
 * standalone, absolutely-positioned variant gives the playlist error / loading
 * state screens (which never mount the list) a back affordance too — without it
 * those states trap users on Android, where the edge-swipe gesture is off.
 */
export function PlaylistBackFab() {
  const { systemColors } = useTheme();
  const { t } = useTranslation('common');
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View pointerEvents="box-none" style={[styles.container, { top: insets.top + spacing[1] }]}>
      <GlassIconButton
        iconName="back"
        iconColor={systemColors.label}
        onPress={() => router.back()}
        accessibilityLabel={t('ariaLabels.back')}
        fallbackColor={systemColors.fill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing[4],
    zIndex: 2,
  },
});
