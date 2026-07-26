import { memo } from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import type { BoardName, BoardPresenceClimb } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../../BoardImageNative';
import { useTheme } from '../../../providers/theme-provider';
import type { BoardConfig } from '../../../providers/drawer-host-provider';

type WallHeroStageProps = {
  /** The lit climb, the previewed climb, or null (idle → background-only render). */
  climb: BoardPresenceClimb | null;
  boardConfig: BoardConfig;
  boardWidth: number;
  boardHeight: number;
  artWidth: number;
  artHeight: number;
};

/**
 * The bare board — the inviolable surface. A full contain-fit `BoardImageNative`
 * at the size the layout engine reserved, drawn SQUARE-cornered on the background
 * so it is literally shown in full. NOTHING is ever rendered over it: no scrim, no
 * HUD, no preview treatment — the only thing on the board is the climb's own lit
 * holds (the render's overlay). Idle (`climb === null`) renders empty frames, which
 * paints the board's background wall + unlit holds only.
 */
function WallHeroStageComponent({
  climb,
  boardConfig,
  boardWidth,
  boardHeight,
  artWidth,
  artHeight,
}: WallHeroStageProps) {
  const { systemColors } = useTheme();
  // Rasterize the holds overlay at the size the kiosk actually draws it instead of
  // the board's native ~1080px. Both LayeredClimbImage layers set
  // `allowDownscaling={false}`, so a native-width overlay decodes at full size
  // (~8 MB of RGBA) no matter how small it is shown — and this surface swaps climbs
  // on every live-wall change and every scrub step, so each one lands another
  // full-size bitmap in the memory cache. The board PHOTO stays full-res
  // (`backgroundVariant="full"`): it's shared by every climb on the wall, so it's
  // one decode either way, and this is the surface where a downgraded photo would
  // show most. Same pairing as SwipeBoardCarousel; `useNativeClimbRender` clamps to
  // native width, so a large kiosk that already draws the board above native
  // resolution is unchanged. Refs #3803.
  const overlayRenderWidth = artWidth > 0 ? Math.round(artWidth * PixelRatio.get()) : undefined;
  return (
    <View style={[styles.root, { width: artWidth, height: artHeight, backgroundColor: systemColors.background }]}>
      <BoardImageNative
        frames={climb?.frames ?? ''}
        boardName={boardConfig.boardName as BoardName}
        layoutId={boardConfig.layoutId}
        sizeId={boardConfig.sizeId}
        setIds={boardConfig.setIds}
        boardWidth={boardWidth}
        boardHeight={boardHeight}
        renderWidth={overlayRenderWidth}
        backgroundVariant="full"
        style={{ width: artWidth, height: artHeight }}
      />
    </View>
  );
}

export const WallHeroStage = memo(WallHeroStageComponent);

const styles = StyleSheet.create({
  // Square corners (no borderRadius clip) so the board is shown in full.
  root: { alignItems: 'center', justifyContent: 'center' },
});
