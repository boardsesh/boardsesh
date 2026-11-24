import { WallKioskView } from './WallKioskView';
import { memo, useMemo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../../lib/board-details';
import { useSprayWallToken } from '../../../lib/spray/use-spray-wall-token';
import { parseSetIds } from '../../../lib/board-presence/parse-set-ids';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { WallEmptyState } from '../WallEmptyState';
import { useWallPreview } from './useWallPreview';
import { WallHeroStage } from './WallHeroStage';
import { WallChromeRegion } from './WallChromeRegion';
import type { WallStateMode } from './WallStateStrip';

/**
 * The wall-mounted kiosk surface. The board is a SIBLING flex region (never an
 * absolute child, never overlapped) docked flush to a single always-reserved
 * off-board chrome region — a trailing RAIL (landscape) or a bottom BAND
 * (portrait). Dead letterbox pools on the board's far edge via the flex
 * alignment. Live / preview / idle all drive off `useWallPreview`; the board just
 * renders whichever climb's holds, undimmed.
 */
function WallKioskScreenComponent({ boardConfig }: { boardConfig: BoardConfig }) {
  // The kiosk is handed a board config and nothing else, so on a wall it would
  // resolve `null` on its first render and show `WallEmptyState` for the whole
  // session. `''` off spray, so no catalogue kiosk changes.
  const sprayToken = useSprayWallToken(boardConfig.boardName, boardConfig.layoutId);
  const renderData = useMemo(() => {
    const setIds = parseSetIds(boardConfig.setIds);
    if (setIds.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds,
    });
    // `sprayToken` recomputes this when the wall lands or is reset.
  }, [boardConfig, sprayToken]);

  const preview = useWallPreview();
  const mode: WallStateMode = preview.isPreviewing ? 'history' : preview.liveClimb ? 'live' : 'idle';
  return (
    <WallKioskView
      renderData={renderData}
      emptyState={<WallEmptyState />}
      renderBoard={(width, height) =>
        renderData ? (
          <WallHeroStage
            climb={preview.displayedClimb}
            isPreviewing={preview.isPreviewing}
            boardConfig={boardConfig}
            boardWidth={renderData.boardWidth}
            boardHeight={renderData.boardHeight}
            artWidth={width}
            artHeight={height}
          />
        ) : null
      }
      renderChrome={(layout) => (
        <WallChromeRegion
          {...layout}
          mode={mode}
          preview={preview}
          boardName={boardConfig.boardName}
          boardConfig={boardConfig}
        />
      )}
    />
  );
}
export const WallKioskScreen = memo(WallKioskScreenComponent);
