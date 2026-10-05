import { glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';

/** Height of the editor bottom bar's tallest member. */
export const SPRAY_BAR_HEIGHT = glassSize.standard;
/** Gap between the bottom bar and the bottom safe area. */
export const SPRAY_BAR_GUTTER = spacing[2];
/** Count controls and primary action occupy separate rows. */
export const SPRAY_BAR_TOTAL_HEIGHT = SPRAY_BAR_HEIGHT * 2 + spacing[2];

/**
 * Vertical room kept free under the photo for the floating bottom bar: the bar,
 * the gutter under it and a matching gap above it. The safe-area inset is added
 * on top.
 */
export const SPRAY_BAR_RESERVE = SPRAY_BAR_TOTAL_HEIGHT + SPRAY_BAR_GUTTER * 3;

/**
 * Deepest pinch zoom in the spray hold editor. Small holds tucked beside big ones
 * need more than the climb view's 4×; the photo is 2048 px on its long side, so
 * past about 8× there is no more detail to see.
 */
export const SPRAY_EDITOR_MAX_SCALE = 8;

/** The shortest the photo slot is ever made, however little room the screen leaves. */
const MIN_SLOT_HEIGHT = 200;

export type SprayPhotoFrame = {
  /** The photo's drawn width, in points. */
  width: number;
  /** The photo's drawn height, in points. */
  height: number;
  /** The height of the slot the photo is centred in: the screen minus the bar's reserve. */
  slotHeight: number;
};

const NO_FRAME: SprayPhotoFrame = { width: 0, height: 0, slotHeight: 0 };

/**
 * Where a wall photo sits on the spray screens: full width, fitted to the height
 * the bottom bar leaves free, and centred in that height.
 *
 * Shared by the scan step and the hold editor, so the photo the scan band
 * sweeps over is the same box, to the point, that the rings then appear on.
 * Zeros until the area and the photo both have a size.
 */
export function fitSprayPhoto({
  areaWidth,
  areaHeight,
  bottomInset,
  photoWidth,
  photoHeight,
}: {
  areaWidth: number;
  areaHeight: number;
  bottomInset: number;
  photoWidth: number;
  photoHeight: number;
}): SprayPhotoFrame {
  if (!(areaWidth > 0) || !(photoWidth > 0) || !(photoHeight > 0)) return NO_FRAME;
  const aspect = photoWidth / photoHeight;
  const slotHeight = Math.max(MIN_SLOT_HEIGHT, areaHeight - bottomInset - SPRAY_BAR_RESERVE);
  if (areaWidth / slotHeight > aspect) {
    return { width: slotHeight * aspect, height: slotHeight, slotHeight };
  }
  return { width: areaWidth, height: areaWidth / aspect, slotHeight };
}
