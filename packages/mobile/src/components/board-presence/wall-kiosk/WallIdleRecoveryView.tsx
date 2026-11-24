import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import type { WallKioskTypeScale } from './wall-kiosk-type';
export function WallIdleRecoveryView({
  lastLitClimb,
  typeScale,
  ledless,
  resolvedGrade,
  relativeTime,
}: {
  lastLitClimb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
  ledless: boolean;
  resolvedGrade: { label: string; color: string };
  relativeTime: string;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const name = lastLitClimb?.name?.trim() || '';
  // Aurora can have a selected-angle Boardsesh estimate without a legacy grade.
  const grade = lastLitClimb?.grade || lastLitClimb?.source === 'aurora' ? resolvedGrade.label : null;
  const gradeColor = resolvedGrade.color;
  const lastLine = { fontSize: typeScale.metaFontSize, lineHeight: typeScale.metaLineHeight };
  const hintLine = { fontSize: Math.round(typeScale.metaFontSize * 0.85) };

  return (
    <View style={styles.idleRoot}>
      {lastLitClimb ? (
        <Text style={lastLine}>
          <Text color={systemColors.secondaryLabel} style={lastLine}>
            {t('mobile.boardPresence.kiosk.lastOnWall')}:{' '}
          </Text>
          <Text color={systemColors.label} style={[styles.idleName, lastLine]}>
            {name}
          </Text>
          {grade ? <Text style={[styles.idleGrade, lastLine, { color: gradeColor }]}> {grade}</Text> : null}
          <Text color={systemColors.secondaryLabel} style={lastLine}>
            {' '}
            · {relativeTime}
          </Text>
        </Text>
      ) : null}
      <Text color={systemColors.secondaryLabel} style={hintLine}>
        {ledless ? t('mobile.boardPresence.kiosk.idleHintNoLeds') : t('mobile.boardPresence.kiosk.idleHint')}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  idleRoot: {
    gap: spacing[2],
  },
  idleName: {
    fontWeight: '700',
  },
  idleGrade: {
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
