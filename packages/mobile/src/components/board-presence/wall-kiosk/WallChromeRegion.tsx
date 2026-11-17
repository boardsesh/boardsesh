import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { useAuroraPresenceClimb } from '../../../hooks/use-aurora-presence-grades';
import { WallIdleRecoveryView } from './WallIdleRecoveryView';
import { WallChromeRegionView } from './WallChromeRegionView';
import { memo } from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { WallStateStrip, type WallStateMode } from './WallStateStrip';
import { WallIdentityBlock } from './WallIdentityBlock';
import { WallScrubber } from './WallScrubber';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { boardHasLights } from '../../../lib/boards/board-lighting';
import { useSprayWallLedsEnabled } from '../../../lib/spray/use-spray-wall-leds-enabled';
import { formatRelativeTime } from '../../../lib/format-relative-time';
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
  boardName,
  boardConfig,
}: {
  lastLitClimb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
  boardName?: string;
  boardConfig?: BoardConfig;
}) {
  const { resolveGrade } = useDisplayGrade();
  const { climb, grade } = useAuroraPresenceClimb(lastLitClimb, boardConfig ?? null);
  const { data: activeBoard } = useActiveBoard();
  const sprayLedsEnabled = useSprayWallLedsEnabled(activeBoard?.boardType, activeBoard?.layoutId);
  return (
    <WallIdleRecoveryView
      lastLitClimb={climb}
      typeScale={typeScale}
      ledless={!boardHasLights(activeBoard) && !sprayLedsEnabled}
      resolvedGrade={resolveGrade(grade ?? { difficulty: climb?.grade ?? '' }, boardName)}
      relativeTime={lastLitClimb ? formatRelativeTime(lastLitClimb.sentAt) : ''}
    />
  );
}

type WallChromeRegionProps = {
  region: WallKioskRegion;
  mode: WallStateMode;
  preview: WallPreviewState;
  typeScale: WallKioskTypeScale;
  /** The chrome region's width, to pick one-, two-, or three-column band content. */
  bandWidth: number;
  /** The kiosk's board, so grades read on its scale (the wall payload names no board). */
  boardName?: string;
  boardConfig?: BoardConfig;
};

/**
 * The single off-board chrome region — the ONLY home for all identity + controls.
 * A vertical RAIL (landscape) with identity top-anchored and the scrubber pinned
 * to the bottom, or a horizontal BAND (portrait) that splits into two or three
 * columns when wide enough and stacks when narrow. Sits on an opaque surface so
 * its text needs no scrim; nothing here ever touches the board. Read from 3–5 m,
 * so it carries the state strip, the grade and the name; detail lines too small
 * to read from the mat (setter, angle, Lit-by / Sent-by avatars) are not drawn.
 */
function WallChromeRegionComponent({
  region,
  mode,
  preview,
  typeScale,
  bandWidth,
  boardName,
  boardConfig,
}: WallChromeRegionProps) {
  const { displayedClimb, liveClimb, isPreviewing, stepsBack, previewTimestamp, lastLitClimb } = preview;
  const bandColumns = region === 'band' ? resolveWallKioskBandColumns(bandWidth) : 1;

  const stateStrip = (
    <WallStateStrip
      mode={mode}
      stepsBack={stepsBack}
      previewTimestamp={previewTimestamp}
      liveClimb={liveClimb}
      typeScale={typeScale}
      boardName={boardName}
      boardConfig={boardConfig}
    />
  );
  const identity =
    mode === 'idle' ? (
      <WallIdleRecovery
        lastLitClimb={lastLitClimb}
        typeScale={typeScale}
        boardName={boardName}
        boardConfig={boardConfig}
      />
    ) : (
      <WallIdentityBlock
        climb={displayedClimb}
        typeScale={typeScale}
        isPreviewing={isPreviewing}
        nameLines={bandColumns === 3 ? 1 : 2}
        boardName={boardName}
        boardConfig={boardConfig}
      />
    );
  const scrubber = <WallScrubber preview={preview} />;

  return (
    <WallChromeRegionView
      region={region}
      bandWidth={bandWidth}
      stateStrip={stateStrip}
      identity={identity}
      scrubber={scrubber}
    />
  );
}

export const WallChromeRegion = memo(WallChromeRegionComponent);
