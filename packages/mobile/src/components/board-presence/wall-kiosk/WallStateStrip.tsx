import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { readableTextColor } from '../../grade/grade-chip-colors';
import { useTheme } from '../../../providers/theme-provider';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { formatRelativeTime } from '../../../lib/format-relative-time';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallKioskTypeScale } from './wall-kiosk-type';

export type WallStateMode = 'live' | 'history' | 'idle';

type WallStateStripProps = {
  mode: WallStateMode;
  stepsBack: number;
  previewTimestamp: string | null;
  /** What the physical wall actually shows (for the on-wall-now line during preview). */
  liveClimb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
};

/**
 * The fixed-slot state indicator — the PRIMARY live-vs-preview tell, and the only
 * place amber appears besides the on-wall-now dot. A FILLED bar whose color flips
 * amber(LIVE) ↔ slate(HISTORY) ↔ neutral(idle) — a positive history signal, not an
 * absence-of-amber wash — so it reads across a gym without ever touching the
 * board. In preview it also names what the wall actually shows.
 */
function WallStateStripComponent({ mode, stepsBack, previewTimestamp, liveClimb, typeScale }: WallStateStripProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  // Read from the active board rather than the Bluetooth context: this memoized
  // leaf re-renders on every glance-line change already, and `useActiveBoard`'s
  // Infinity-staleTime query keeps a stable identity where the Bluetooth context
  // value churns. Optional-field contract: only an explicit `false` is ledless.
  const { data: activeBoard } = useActiveBoard();
  const ledless = activeBoard?.hasLeds === false;

  const barColor =
    mode === 'live' ? brandColors.live : mode === 'history' ? brandColors.historyFill : systemColors.fill;
  // Contrast-correct text ON the fill: readableTextColor over the known-hex live /
  // history fills (near-black on the bright amber, white on the slate). The idle
  // grey is a translucent platform fill, not a hex, so use the adaptive label
  // (dark on light / light on dark) — the same "readable on the fill" outcome
  // without a luminance calc on a native color.
  const barTextColor =
    mode === 'idle'
      ? systemColors.label
      : readableTextColor(mode === 'live' ? brandColors.live : brandColors.historyFill);

  // A wall with no light kit is never "dark" — nothing was ever lit — so the idle
  // glance line says what is actually true: nobody has put a climb up yet. Bar
  // colour and label colour are unchanged.
  const idleLine = ledless ? t('mobile.boardPresence.kiosk.nothingUpYet') : t('mobile.boardPresence.kiosk.wallDark');
  const glanceLine =
    mode === 'live'
      ? t('mobile.boardPresence.kiosk.liveBadge')
      : mode === 'history'
        ? `${t('mobile.boardPresence.kiosk.historyBadge')} · ${t('mobile.boardPresence.kiosk.historyPosition', {
            count: stepsBack,
          })}`
        : idleLine;
  const detailLine = mode === 'history' ? formatRelativeTime(previewTimestamp) : null;

  const stateTextStyle = { fontSize: typeScale.stateFontSize, lineHeight: typeScale.stateLineHeight };
  const detailTextStyle = {
    fontSize: Math.round(typeScale.stateFontSize * 0.7),
    lineHeight: Math.round(typeScale.stateLineHeight * 0.7),
  };
  const liveName = liveClimb?.name?.trim() || null;
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — lights up once the backend stamps them.
  const liveResolvedGrade = resolveGrade({ difficulty: liveClimb?.grade ?? '' });
  const liveGrade = liveClimb?.grade ? liveResolvedGrade.label : null;
  const liveGradeColor = liveResolvedGrade.color;

  return (
    <View style={styles.root}>
      <View style={[styles.bar, { backgroundColor: barColor }]}>
        {mode === 'live' ? <View style={[styles.dot, { backgroundColor: barTextColor }]} /> : null}
        <View style={styles.barTextGroup}>
          <Text
            color={barTextColor}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            style={[styles.barText, stateTextStyle]}
          >
            {glanceLine}
          </Text>
          {detailLine ? (
            <Text color={barTextColor} numberOfLines={1} style={[styles.barDetail, detailTextStyle]}>
              {detailLine}
            </Text>
          ) : null}
        </View>
      </View>

      {mode === 'history' && liveName ? (
        <View style={styles.onWallRow}>
          <View style={[styles.liveDot, { backgroundColor: brandColors.live }]} />
          <Text color={systemColors.secondaryLabel} numberOfLines={1} style={styles.onWallLabel}>
            {t('mobile.boardPresence.kiosk.liveBadge')}
          </Text>
          <Text color={systemColors.label} numberOfLines={1} style={styles.onWallName}>
            {liveName}
          </Text>
          {liveGrade ? (
            <Text numberOfLines={1} style={[styles.onWallGrade, { color: liveGradeColor }]}>
              {liveGrade}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const WallStateStrip = memo(WallStateStripComponent);

const styles = StyleSheet.create({
  root: { gap: spacing[2] },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.md,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  barTextGroup: {
    flexShrink: 1,
    gap: 2,
  },
  barText: {
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  barDetail: {
    fontWeight: '600',
    opacity: 0.85,
  },
  onWallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[1],
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  onWallLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  onWallName: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: '700',
  },
  onWallGrade: {
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
