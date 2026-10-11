import { CLIMB_ROW_FIELD_IDS, DEFAULT_CLIMB_ROW_DISPLAY } from '../../../lib/climb-row-display';
import { climbRowLayout, type ClimbRowLayoutInput } from '../../climb-row-layout';

export const CLIMB_ROW_PREVIEW_WINDOW_HEIGHT = 117;
export const CLIMB_ROW_PRESET_HEIGHT = 60;

/** A stable viewport for every switch combination, including mirrored directions. */
export function climbRowPreviewLayout(fontScale: number, typeScale?: ClimbRowLayoutInput['typeScale']) {
  const display = { ...DEFAULT_CLIMB_ROW_DISPLAY };
  for (const field of CLIMB_ROW_FIELD_IDS) display[field] = true;
  const tallestRow = Math.max(
    ...[false, true].flatMap((thumbnail) =>
      [false, true].map(
        (progress) =>
          climbRowLayout({
            display: { ...display, thumbnail, progress },
            fontScale,
            typeScale,
            supportsMirroring: true,
            surface: { showAscentStatus: true, showPlaylistChips: true, showProgress: true, detailLine: 'computed' },
          }).estimatedHeight,
      ),
    ),
  );
  const windowHeight = Math.max(CLIMB_ROW_PREVIEW_WINDOW_HEIGHT, tallestRow);
  const presetHeight = CLIMB_ROW_PRESET_HEIGHT * Math.max(1, fontScale);
  return { windowHeight, height: windowHeight + presetHeight };
}
