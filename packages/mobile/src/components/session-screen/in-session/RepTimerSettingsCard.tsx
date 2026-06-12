import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '../../Card';
import { Icon } from '../../Icon';
import { SegmentedControl } from '../../SegmentedControl';
import { Text } from '../../Text';
import {
  REP_TIMER_TARGET_SECONDS,
  type RepTimerTargetSeconds,
  useRepTimerPreference,
} from '../../../lib/rep-timer-preference';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { formatRepTimerTarget } from '../../queue-control/rep-timer';

type RepTimerTargetKey = `${RepTimerTargetSeconds}`;

function toTargetKey(targetSeconds: RepTimerTargetSeconds): RepTimerTargetKey {
  return String(targetSeconds) as RepTimerTargetKey;
}

function toTargetSeconds(targetKey: RepTimerTargetKey): RepTimerTargetSeconds | null {
  const seconds = Number(targetKey);
  return (REP_TIMER_TARGET_SECONDS as readonly number[]).includes(seconds) ? (seconds as RepTimerTargetSeconds) : null;
}

export function RepTimerSettingsCard() {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { targetSeconds, setTargetSeconds } = useRepTimerPreference();
  const options = useMemo(
    () =>
      REP_TIMER_TARGET_SECONDS.map((seconds) => ({
        key: toTargetKey(seconds),
        label: formatRepTimerTarget(seconds),
      })),
    [],
  );

  const handleSelect = useCallback(
    (nextKey: RepTimerTargetKey) => {
      const nextTargetSeconds = toTargetSeconds(nextKey);
      if (nextTargetSeconds != null) setTargetSeconds(nextTargetSeconds);
    },
    [setTargetSeconds],
  );

  return (
    <Card>
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <View style={[styles.iconSlot, { backgroundColor: systemColors.tertiaryBackground }]}>
            <Icon name="clock" size={18} color={brandColors.primary} />
          </View>
          <Text variant="headline" style={styles.title}>
            {t('mobile.session.repTimerTitle')}
          </Text>
        </View>
        <View style={styles.targetRow}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.targetLabel}>
            {t('mobile.session.repTimerTarget')}
          </Text>
          <View style={styles.segmentedControl}>
            <SegmentedControl
              options={options}
              selectedKey={toTargetKey(targetSeconds)}
              onSelect={handleSelect}
              textVariant="footnote"
              trackColor={systemColors.tertiaryBackground}
              accessibilityLabel={t('mobile.session.repTimerTargetAria')}
            />
          </View>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  iconSlot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontWeight: '600',
  },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  targetLabel: {
    minWidth: 52,
    fontWeight: '600',
  },
  segmentedControl: {
    flex: 1,
  },
});
