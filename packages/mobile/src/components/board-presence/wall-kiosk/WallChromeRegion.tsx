import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { WallStateStrip, type WallStateMode } from './WallStateStrip';
import { WallIdentityBlock } from './WallIdentityBlock';
import { WallScrubber } from './WallScrubber';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { formatRelativeTime } from '../../../lib/format-relative-time';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallKioskRegion } from './wall-kiosk-layout';
import type { WallKioskTypeScale } from './wall-kiosk-type';
import type { WallPreviewState } from './useWallPreview';

/**
 * The idle-recovery content that stands in for the identity block when the wall is
 * dark. Names what was last on the wall (if we know it) so the kiosk points back at
 * a real climb to relight, then a climber-voice hint for how to bring it back —
 * top-anchored under the state strip, never centered.
 */
function WallIdleRecovery({
  lastLitClimb,
  typeScale,
}: {
  lastLitClimb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  const name = lastLitClimb?.name?.trim() || '';
  const grade = lastLitClimb?.grade ? formatGrade(lastLitClimb.grade) : null;
  const gradeColor = getGradeColor(lastLitClimb?.grade ?? '') ?? DEFAULT_GRADE_COLOR;
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
            · {formatRelativeTime(lastLitClimb.sentAt)}
          </Text>
        </Text>
      ) : null}
      <Text color={systemColors.secondaryLabel} style={hintLine}>
        {t('mobile.boardPresence.kiosk.idleHint')}
      </Text>
    </View>
  );
}

/** A band wider than this can seat identity and controls side by side; narrower
 *  than this stacks them (a tall board's band is only board-width). */
const BAND_TWO_COLUMN_MIN = 640;

type WallChromeRegionProps = {
  region: WallKioskRegion;
  mode: WallStateMode;
  preview: WallPreviewState;
  typeScale: WallKioskTypeScale;
  /** The chrome region's width, to pick two-column vs stacked in a band. */
  bandWidth: number;
  /** The dominance cap starved the region (extreme aspect ratio) → shed the
   *  lower-priority identity lines so the controls still fit. */
  compact: boolean;
};

/**
 * The single off-board chrome region — the ONLY home for all identity + controls.
 * A vertical RAIL (landscape) with identity top-anchored and the scrubber pinned
 * to the bottom, or a horizontal BAND (portrait) that splits into two columns when
 * wide enough and stacks when narrow. Sits on an opaque surface so its text needs
 * no scrim; nothing here ever touches the board.
 */
function WallChromeRegionComponent({ region, mode, preview, typeScale, bandWidth, compact }: WallChromeRegionProps) {
  const { systemColors } = useTheme();
  const { displayedClimb, liveClimb, isPreviewing, stepsBack, previewTimestamp, lastLitClimb } = preview;

  const stateStrip = (
    <WallStateStrip
      mode={mode}
      stepsBack={stepsBack}
      previewTimestamp={previewTimestamp}
      liveClimb={liveClimb}
      typeScale={typeScale}
    />
  );
  const identity =
    mode === 'idle' ? (
      <WallIdleRecovery lastLitClimb={lastLitClimb} typeScale={typeScale} />
    ) : (
      <WallIdentityBlock
        climb={displayedClimb}
        typeScale={typeScale}
        isPreviewing={isPreviewing}
        driverSize={region === 'rail' ? 32 : 28}
        compact={compact}
      />
    );
  const scrubber = <WallScrubber preview={preview} />;

  const surface = [styles.surface, { backgroundColor: systemColors.elevatedSurface }];

  if (region === 'rail') {
    return (
      <View style={[surface, styles.rail]}>
        <View style={styles.railTop}>
          {stateStrip}
          {identity}
        </View>
        {scrubber}
      </View>
    );
  }

  if (bandWidth >= BAND_TWO_COLUMN_MIN) {
    return (
      <View style={[surface, styles.bandRow]}>
        <View style={styles.bandLeft}>
          {stateStrip}
          {identity}
        </View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandRight}>{scrubber}</View>
      </View>
    );
  }

  return (
    <View style={[surface, styles.bandStacked]}>
      {stateStrip}
      {identity}
      {scrubber}
    </View>
  );
}

export const WallChromeRegion = memo(WallChromeRegionComponent);

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    overflow: 'hidden',
  },
  rail: {
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  railTop: {
    gap: spacing[3],
  },
  bandRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing[4],
  },
  bandLeft: {
    flex: 0.55,
    gap: spacing[3],
    justifyContent: 'flex-start',
  },
  bandSeparator: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  bandRight: {
    flex: 0.45,
    justifyContent: 'center',
  },
  bandStacked: {
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
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
