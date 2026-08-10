// Small icon button floated inside the persistent climb capsule's `endAction`
// slot: while a session is live and the user is elsewhere in the app, this
// gives a one-tap way back to the Record tab. "Minimize" is now just tab
// switching (see #2560), so the badge alone left no return affordance — this
// closes that gap (#2563).

import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { glassSize } from '../../theme/layout';
import { hapticLight } from '../../lib/haptics';

export function ReturnToSessionButton() {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  const router = useRouter();

  const handlePress = () => {
    hapticLight();
    router.navigate('/(tabs)/record');
  };

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.session.returnToSession')}
      style={[styles.action, { width: glassSize.inline, height: glassSize.inline }]}
    >
      <Icon name="record" size={20} color={brandColors.live} />
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
