import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import {
  BOKEH_DARK_SURFACE,
  bokehPixel,
  buildBokehBlobs,
  type BokehBlob,
  type BokehSize,
} from '@boardsesh/frosted-bokeh';
import { formatVGrade } from '@boardsesh/play-view';
import { contrast, MIN_LABEL_CONTRAST } from '../../components/play-drawer/wall-glow';
import type { WallGlowInput } from '../../components/play-drawer/use-wall-glow';

// The Android lock screen card's panels, in dp. The service scales these to its
// bitmaps; a phone's real panel width only stretches an already blurred picture.
export const ANDROID_CARD_EXPANDED: BokehSize = { w: 347, h: 140 };
export const ANDROID_CARD_COLLAPSED: BokehSize = { w: 347, h: 48 };

// Holds sit in a band behind the controls. Spread behind the text too, they need
// so much scrim for 4.5:1 that the pattern disappears.
const EXPANDED_BAND_TOP = 84;

const TEXT_SCRIM = 0.8;
const GRADE_LIFT_STEP = 0.05;

// Where the coloured grade is drawn: the expanded card's top right slot and the
// collapsed card's text line.
const GRADE_ZONES = [
  { panel: 'expanded', left: 291, right: 347, top: 8, bottom: 44 },
  { panel: 'collapsed', left: 56, right: 255, top: 4, bottom: 44 },
] as const;

export type AndroidCardBlob = Pick<BokehBlob, 'x' | 'y' | 'r' | 'peak' | 'color'>;

export type AndroidCardPayload = {
  expanded: AndroidCardBlob[];
  collapsed: AndroidCardBlob[];
  gradeLabel: string | null;
  gradeColor: string | null;
  angleLabel: string | null;
};

function roundBlob({ x, y, r, peak, color }: BokehBlob): AndroidCardBlob {
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    r: Math.round(r * 10) / 10,
    peak: Math.round(peak * 1000) / 1000,
    color,
  };
}

function panelBlobs(glow: WallGlowInput, target: BokehSize, offsetY: number): BokehBlob[] {
  return buildBokehBlobs({
    points: glow.holds,
    source: { w: glow.boardWidth, h: glow.boardHeight },
    target,
    rotation: 'clockwise',
  }).map((blob) => ({ ...blob, y: blob.y + offsetY }));
}

function towardsWhite(hex: string, amount: number): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const lifted = channels.map((channel) => Math.round(channel + (255 - channel) * amount));
  return `#${lifted.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function gradeZonePixels(expanded: readonly BokehBlob[], collapsed: readonly BokehBlob[]): string[] {
  const pixels: string[] = [];
  for (const zone of GRADE_ZONES) {
    const blobs = zone.panel === 'expanded' ? expanded : collapsed;
    for (let column = 0; column <= 8; column += 1) {
      for (let row = 0; row <= 4; row += 1) {
        const point = {
          x: zone.left + ((zone.right - zone.left) * column) / 8,
          y: zone.top + ((zone.bottom - zone.top) * row) / 4,
        };
        // `fade` lays the scrim under the frost and grain. The card bakes it over
        // the frost, which is darker, so this errs on the side of more contrast.
        pixels.push(bokehPixel(point, blobs, { surface: BOKEH_DARK_SURFACE, blend: 'screen', fade: TEXT_SCRIM }));
      }
    }
  }
  return pixels;
}

/**
 * The band colour, mixed toward white only as far as 4.5:1 against the brightest
 * pixel under the grade needs. High grades are dark on this surface (V17 starts
 * at about 1.1:1), so the shared table stays as it is and the lift happens here.
 */
export function readableGradeColor(
  gradeColor: string,
  expanded: readonly BokehBlob[],
  collapsed: readonly BokehBlob[],
): string {
  const pixels = gradeZonePixels(expanded, collapsed);
  for (let amount = 0; amount < 1; amount += GRADE_LIFT_STEP) {
    const candidate = towardsWhite(gradeColor, amount);
    if (pixels.every((pixel) => contrast(candidate, pixel) >= MIN_LABEL_CONTRAST)) return candidate;
  }
  return '#FFFFFF';
}

/**
 * Everything the Android card needs that only JS knows. Empty blob lists are the
 * new card on a plain surface, for a climb whose board geometry isn't loaded yet.
 */
export function buildAndroidCardPayload({
  glow,
  difficulty,
  boardName,
  angle,
}: {
  glow: WallGlowInput | null;
  difficulty: string | null | undefined;
  boardName: string | null | undefined;
  angle: number | null | undefined;
}): AndroidCardPayload {
  const expanded = glow ? panelBlobs(glow, { w: ANDROID_CARD_EXPANDED.w, h: 56 }, EXPANDED_BAND_TOP) : [];
  const collapsed = glow ? panelBlobs(glow, ANDROID_CARD_COLLAPSED, 0) : [];
  const gradeLabel = formatVGrade(difficulty, boardName);
  const bandColor = gradeLabel ? getGradeColor(difficulty) : undefined;
  return {
    expanded: expanded.map(roundBlob),
    collapsed: collapsed.map(roundBlob),
    gradeLabel,
    gradeColor: bandColor ? readableGradeColor(bandColor, expanded, collapsed) : null,
    // -1 is the native side's "no angle" sentinel.
    angleLabel: typeof angle === 'number' && Number.isFinite(angle) && angle !== -1 ? `${angle}°` : null,
  };
}
