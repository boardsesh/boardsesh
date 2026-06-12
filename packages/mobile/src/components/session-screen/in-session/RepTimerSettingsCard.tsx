import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '../../Card';
import { Icon } from '../../Icon';
import { SegmentedControl } from '../../SegmentedControl';
import { Text } from '../../Text';
import {
  REP_TIMER_TARGET_SECONDS,
  type RepTimerTargetPreference,
  type RepTimerTargetSeconds,
  useRepTimerPreference,
} from '../../../lib/rep-timer-preference';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { formatRepTimerTarget } from '../../queue-control/rep-timer';

const REP_TIMER_OFF_KEY = 'off';

type RepTimerTargetKey = typeof REP_TIMER_OFF_KEY | `${RepTimerTargetSeconds}`;
type RepTimerTargetOption = {
  key: RepTimerTargetKey;
  label: string;
};

function toTargetKey(targetSeconds: RepTimerTargetPreference): RepTimerTargetKey {
  if (targetSeconds === null) return REP_TIMER_OFF_KEY;
  return String(targetSeconds) as RepTimerTargetKey;
}

function toTargetSeconds(targetKey: RepTimerTargetKey): RepTimerTargetPreference | undefined {
  if (targetKey === REP_TIMER_OFF_KEY) return null;
  const seconds = Number(targetKey);
  return (REP_TIMER_TARGET_SECONDS as readonly number[]).includes(seconds)
    ? (seconds as RepTimerTargetSeconds)
    : undefined;
}

export function RepTimerSettingsCard() {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { targetSeconds, loaded, setTargetSeconds } = useRepTimerPreference();
  const offLabel = t('mobile.session.repTimerOff');
  const currentTargetLabel = targetSeconds === null ? offLabel : formatRepTimerTarget(targetSeconds);
  const options = useMemo<RepTimerTargetOption[]>(
    () => [
      { key: REP_TIMER_OFF_KEY, label: offLabel },
      ...REP_TIMER_TARGET_SECONDS.map((seconds) => ({
        key: toTargetKey(seconds),
        label: formatRepTimerTarget(seconds),
      })),
    ],
    [offLabel],
  );

  const handleSelect = useCallback(
    (nextKey: RepTimerTargetKey) => {
      const nextTargetSeconds = toTargetSeconds(nextKey);
      if (nextTargetSeconds !== undefined) setTargetSeconds(nextTargetSeconds);
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
          {loaded ? (
            <View
              style={[
                styles.currentPill,
                { backgroundColor: systemColors.tertiaryBackground, borderColor: brandColors.primary },
              ]}
            >
              <Text variant="footnote" color={brandColors.primary} style={styles.currentPillText}>
                {currentTargetLabel}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.targetRow}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.targetLabel}>
            {t('mobile.session.repTimerTarget')}
          </Text>
          <View style={styles.segmentedControl}>
            <SegmentedControl
              options={options}
              selectedKey={loaded ? toTargetKey(targetSeconds) : null}
              onSelect={handleSelect}
              textVariant="footnote"
              trackColor={systemColors.tertiaryBackground}
              selectedTrackColor={brandColors.primaryFill}
              selectedTextColor={brandColors.onPrimary}
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
  currentPill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  currentPillText: {
    fontWeight: '700',
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
