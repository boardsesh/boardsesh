import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { orderScanTips, type ScanTip } from '../../lib/ble/scan-tips';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Text } from '../Text';

type ScanTipsProps = {
  /** The board the scan is for; a MoonBoard moves the other-phone tip up. Undefined for any board. */
  boardName?: string;
};

/**
 * "Don't see your board?" and what to try, one line per tip, in the order
 * `orderScanTips` gives. The device picker and the /boards quickstart both show
 * it, from 5 s into a scan that has heard nothing to pick.
 */
export function ScanTips({ boardName }: ScanTipsProps) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();

  // Literal keys per tip: the i18n lint rejects a computed one.
  const tipText = (tip: ScanTip): string => {
    switch (tip) {
      case 'power':
        return t('ble.scanTipPower');
      case 'closer':
        return t('ble.scanTipCloser');
      case 'bluetooth':
        return t('ble.scanTipBluetooth');
      case 'other_phone':
        return t('ble.scanTipOtherPhone');
      case 'moonboard_other_phone':
        return t('ble.scanTipOtherPhoneMoonBoard');
    }
  };

  return (
    <View style={styles.tips}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
        {t('ble.troubleshootTitle')}
      </Text>
      {orderScanTips(boardName).map((tip) => (
        <Text key={tip} variant="caption1" color={systemColors.secondaryLabel} style={styles.centered}>
          {tipText(tip)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tips: {
    alignItems: 'center',
    gap: spacing[1],
  },
  centered: {
    textAlign: 'center',
  },
});
