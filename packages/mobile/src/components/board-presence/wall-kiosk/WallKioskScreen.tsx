import { WallKioskView } from './WallKioskView';
import { memo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardRenderData } from '../../../lib/use-board-render-data';
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
  const renderData = useBoardRenderData({
    boardName: boardConfig.boardName as BoardName,
    layoutId: boardConfig.layoutId,
    sizeId: boardConfig.sizeId,
    setIds: boardConfig.setIds,
  });

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
