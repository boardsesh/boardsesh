import { Pressable, type ColorValue } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';

/** A visible way out even when a cold deep link created no back history. */
export function SprayWizardExitButton({ returnTo, tintColor }: { returnTo: BoardReturnTo; tintColor?: ColorValue }) {
  const router = useRouter();
  const { t } = useTranslation('common');
  return (
    <Pressable
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.dismissTo(returnTo);
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('ariaLabels.close')}
    >
      <Icon name="close" size={22} color={tintColor} />
    </Pressable>
  );
}
