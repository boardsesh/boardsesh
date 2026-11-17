import { supportsAuraGpu } from '@boardsesh/board-look';
import { NativeMotionClimbOverlayGPU } from '../../../modules/climb-overlay-gpu/src';
import { climbOverlayGpuApiVersion } from '../../lib/board-render/gpu-native-capability';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { useGpuClimbOverlayEnabled } from '../../providers/feature-flags-provider';

/**
 * Whether the player draws this board's lit holds on the live GPU: the
 * stationary carousel, with the wall swap. When it does, a play-size PNG is
 * work nobody looks at, so neither the tap prewarm nor the upcoming-climb
 * prefetch renders one. A per-session GPU failure is not visible here; the
 * carousel adds that, and a board that falls back to PNG renders its own.
 */
export function usePlayerGpuBoard(boardName: string, layoutId: number): boolean {
  const { settings } = useBoardRenderSettings();
  const gpuEnabled = useGpuClimbOverlayEnabled(boardName, layoutId);
  return (
    gpuEnabled &&
    NativeMotionClimbOverlayGPU !== null &&
    supportsAuraGpu({
      boardName,
      layoutId,
      catalogueNative: climbOverlayGpuApiVersion >= 5,
      renderMode: settings.mode,
      softDisc: settings.boardsesh.softDisc,
      markStyle: settings.boardsesh.markStyle,
    })
  );
}
