import { memo, useCallback } from 'react';
import { useOptionalBluetoothContext } from '../../../providers/bluetooth-provider';
import { trackBoardConnectTapped } from '../../../lib/analytics-board-connect';
import { WallScrubberView } from './WallScrubberView';
import type { WallPreviewState } from './useWallPreview';
export const WallScrubber = memo(function WallScrubber({ preview }: { preview: WallPreviewState }) {
  const bluetooth = useOptionalBluetoothContext();
  const handleConnect = useCallback(() => {
    if (!bluetooth) return;
    trackBoardConnectTapped({ surface: 'wall_kiosk', boardName: bluetooth.boardName, reconnect: false });
    void bluetooth.connect();
  }, [bluetooth]);
  return (
    <WallScrubberView
      preview={preview}
      ledless={bluetooth?.ledless ?? false}
      onConnect={bluetooth ? handleConnect : undefined}
      takeVirtualWall={bluetooth?.takeVirtualWall}
    />
  );
});
