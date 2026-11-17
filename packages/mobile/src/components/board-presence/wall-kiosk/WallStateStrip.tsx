import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { useAuroraPresenceClimb } from '../../../hooks/use-aurora-presence-grades';
import { memo } from 'react';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { boardHasLights } from '../../../lib/boards/board-lighting';
import { useSprayWallLedsEnabled } from '../../../lib/spray/use-spray-wall-leds-enabled';
import { formatRelativeTime } from '../../../lib/format-relative-time';
import { WallStateStripView, type WallStateStripViewProps } from './WallStateStripView';
export type { WallStateMode } from './WallStateStripView';
type WallStateStripProps = Omit<WallStateStripViewProps, 'ledless' | 'liveResolvedGrade' | 'detailLine'> & {
  boardName?: string;
  boardConfig?: BoardConfig;
};
export const WallStateStrip = memo(function WallStateStrip({ boardName, boardConfig, ...props }: WallStateStripProps) {
  const { resolveGrade } = useDisplayGrade();
  const { climb: liveClimb, grade } = useAuroraPresenceClimb(props.liveClimb, boardConfig ?? null);
  const { data: activeBoard } = useActiveBoard();
  const sprayLedsEnabled = useSprayWallLedsEnabled(activeBoard?.boardType, activeBoard?.layoutId);
  return (
    <WallStateStripView
      {...props}
      liveClimb={liveClimb}
      ledless={!boardHasLights(activeBoard) && !sprayLedsEnabled}
      liveResolvedGrade={resolveGrade(grade ?? { difficulty: liveClimb?.grade ?? '' }, boardName)}
      detailLine={props.mode === 'history' ? formatRelativeTime(props.previewTimestamp) : null}
    />
  );
});
