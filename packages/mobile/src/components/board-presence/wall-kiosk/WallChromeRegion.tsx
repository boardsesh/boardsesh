import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardClimbRecentSender, BoardPresenceClimb } from '@boardsesh/shared-schema';
import { WallStateStrip, type WallStateMode } from './WallStateStrip';
import { WallAttributionBlock, WallIdentityBlock } from './WallIdentityBlock';
import { WallScrubber } from './WallScrubber';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { formatRelativeTime } from '../../../lib/format-relative-time';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallKioskRegion } from './wall-kiosk-layout';
import { resolveWallKioskBandColumns, type WallKioskTypeScale } from './wall-kiosk-type';
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
  const { resolveGrade } = useDisplayGrade();

  const name = lastLitClimb?.name?.trim() || '';
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — lights up once the backend stamps them.
  const resolvedGrade = resolveGrade({ difficulty: lastLitClimb?.grade ?? '' });
  const grade = lastLitClimb?.grade ? resolvedGrade.label : null;
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

type WallChromeRegionProps = {
  region: WallKioskRegion;
  mode: WallStateMode;
  preview: WallPreviewState;
  typeScale: WallKioskTypeScale;
  /** The chrome region's width, to pick one-, two-, or three-column band content. */
  bandWidth: number;
  /** The dominance cap starved the region (extreme aspect ratio) → shed the
   *  lower-priority identity lines so the controls still fit. */
  compact: boolean;
  recentSenders: BoardClimbRecentSender[];
};

/**
 * The single off-board chrome region — the ONLY home for all identity + controls.
 * A vertical RAIL (landscape) with identity top-anchored and the scrubber pinned
 * to the bottom, or a horizontal BAND (portrait) that splits into two columns when
 * wide enough and stacks when narrow. Sits on an opaque surface so its text needs
 * no scrim; nothing here ever touches the board.
 */
function WallChromeRegionComponent({
  region,
  mode,
  preview,
  typeScale,
  bandWidth,
  compact,
  recentSenders,
}: WallChromeRegionProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { displayedClimb, liveClimb, isPreviewing, stepsBack, previewTimestamp, lastLitClimb } = preview;
  const bandColumns = region === 'band' ? resolveWallKioskBandColumns(bandWidth) : 1;
  const separateAttribution = bandColumns >= 2;
  const setter = displayedClimb?.setter?.trim() || null;

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
        recentSenders={recentSenders}
        showAttribution={!separateAttribution}
        showSetter={bandColumns !== 3}
        nameLines={bandColumns === 3 ? 1 : 2}
        driverSize={region === 'rail' ? 32 : 28}
        compact={compact}
      />
    );
  const attribution =
    mode !== 'idle' && separateAttribution ? (
      <WallAttributionBlock
        climb={displayedClimb}
        typeScale={typeScale}
        recentSenders={recentSenders}
        driverSize={28}
        compact={compact}
      />
    ) : null;
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

  if (bandColumns === 3) {
    return (
      <View style={[surface, styles.bandRow]}>
        <View style={styles.bandPrimaryThree}>{identity}</View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandAttributionThree}>
          {stateStrip}
          {setter ? (
            <Text
              numberOfLines={1}
              color={systemColors.secondaryLabel}
              style={{ fontSize: typeScale.metaFontSize, lineHeight: typeScale.metaLineHeight }}
            >
              {t('mobile.boardPresence.setByLine', { setter })}
            </Text>
          ) : null}
          {attribution}
        </View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandControlsThree}>{scrubber}</View>
      </View>
    );
  }

  if (bandColumns === 2) {
    return (
      <View style={[surface, styles.bandRow]}>
        <View style={styles.bandLeft}>
          {stateStrip}
          {identity}
        </View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandRight}>
          {attribution}
          {scrubber}
        </View>
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
    gap: spacing[4],
  },
  bandPrimaryThree: {
    flex: 0.46,
    gap: spacing[3],
    justifyContent: 'flex-start',
  },
  bandAttributionThree: {
    flex: 0.26,
    gap: spacing[3],
    justifyContent: 'center',
  },
  bandControlsThree: {
    flex: 0.28,
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
