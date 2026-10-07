import { captionBlockHeight, resolveHeroThumb, type CaptionLineHeights } from '../board-look/board-look-card-metrics';
import { spacing } from '../../theme/tokens';

/** The measured rail slot includes padding that the card cannot occupy. */
export function fitSprayLookHero({
  aspect,
  windowWidth,
  railSlotHeight,
  captionLineHeights,
  fontScale,
}: {
  aspect: number;
  windowWidth: number;
  railSlotHeight: number;
  captionLineHeights: CaptionLineHeights;
  fontScale: number;
}) {
  return resolveHeroThumb({
    aspect,
    windowWidth,
    heightBudget: railSlotHeight - spacing[4] * 2 - captionBlockHeight(captionLineHeights, fontScale, 0),
  });
}
