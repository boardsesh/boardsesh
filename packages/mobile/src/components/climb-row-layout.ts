import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from './climb-list-thumbnail-metrics';
import { spacing } from '../theme/tokens';
import { textStyles } from '../theme/typography';
import { PROGRESS_MAX_FONT_SCALE } from '../lib/climb-progress';
import type { ClimbRowDisplay } from '../lib/climb-row-display';

// The geometry of a climb row that depends on what the row shows. Pure, so every
// host of the row visual (the Climbs list, its skeleton, the queue, playlists, the
// workout preview) asks one function instead of repeating the arithmetic.
//
// `climbRowLayout` is the one place that turns the climber's switches into a
// structure: which lines the row has, where the community grade and the sent
// mark sit, and how tall the row comes out. `ClimbListItemContent` and
// `ClimbListRowSkeleton` draw from its answer, so what is drawn and what is
// estimated cannot drift apart.

/**
 * The row's leading and trailing margin: 16pt, the HIG layout margin on iPhone
 * (HIG Layout) and the M3 list item's 16dp horizontal padding (M3 Lists). The
 * thumbnail lines up with section headers and every other list in the app.
 */
export const CLIMB_ROW_GUTTER = spacing[4];

/** The gap between the row's columns: thumbnail, text, grade. */
const CLIMB_ROW_COLUMN_GAP = spacing[3];

/** The padding above and below the row's content. Every host of the row visual pads by this. */
export const CLIMB_ROW_VERTICAL_PADDING = spacing[2];

/** A row is never shorter than a touch target (HIG: 44pt). */
export const CLIMB_ROW_MIN_HEIGHT = 44;

/**
 * The same floor, as the text column carries it. With a thumbnail the thumbnail
 * is what keeps a row tall. Without one the text column does, so the floor
 * holds in every host with no host having to set it.
 */
export const CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT = CLIMB_ROW_MIN_HEIGHT - 2 * CLIMB_ROW_VERTICAL_PADDING;

/** Large text may wrap a name; drag hosts keep the one-line reorder geometry. */
export function climbRowNameLines(fontScale: number, allowNameWrapping = true): 1 | 2 {
  return allowNameWrapping && fontScale >= 1.3 ? 2 : 1;
}

/** The gap between the lines of the text column. */
export const CLIMB_ROW_LINE_GAP = 2;
export const CLIMB_ROW_SET_ANGLE_MARGIN_TOP = -2;
export const CLIMB_ROW_GRADE_LINE_GAP = 1;

/**
 * The playlist tags line as `ClimbPlaylistChips` draws it. Kept here so the
 * chips and the height estimate below read the same numbers.
 */
export const CLIMB_ROW_TAGS_LINE = {
  marginTop: spacing[1],
  chipMinHeight: 20,
  chipPaddingVertical: 2,
  /** The tags are the row's lowest-priority line, so their text stops growing here. */
  maxFontScale: 1.3,
} as const;

/** A mirror board's direction statuses as the row draws them: a 12pt glyph and a caption per direction. */
export const CLIMB_ROW_DIRECTION_STATUS = {
  iconSize: 12,
  /** Between the two directions when they stack (thumbnail on). */
  stackedGap: 1,
  /** Between the two directions when they share one line (thumbnail off). */
  inlineGap: spacing[2],
} as const;

/**
 * Where a row's separator starts, so it sits under the text column: 104pt on a
 * plain row with a thumbnail (gutter + thumbnail + gap), the gutter alone
 * without one.
 *
 * `leadingInset` is where the row's first column starts, measured from the row's
 * leading edge. It defaults to the gutter. A host that puts a slot in front of
 * the thumbnail (the queue's position number, the playlist editor's remove
 * button) or pads tighter than the gutter passes its own figure.
 */
export function climbRowSeparatorInset(showThumbnail: boolean, leadingInset: number = CLIMB_ROW_GUTTER): number {
  return leadingInset + (showThumbnail ? THUMBNAIL_WIDTH + CLIMB_ROW_COLUMN_GAP : 0);
}

/**
 * What a host lets its rows show. Each is a capability, ANDed with the
 * climber's switch: a host that already leaves an element out keeps leaving it
 * out whatever the switches say.
 *
 * The favourite heart and the ⋮ button are not here: neither adds a line or
 * changes the row's height, so no answer below depends on them.
 */
export type ClimbRowSurface = {
  /** The host's `showAscentStatus`. False where the host shows the status itself. */
  showAscentStatus: boolean;
  /** Only browse, playlist detail, profile climbs and Settings opt in. */
  showProgress?: boolean;
  /** The host's `showPlaylistChips`. Only the Climbs list has the data for tags. */
  showPlaylistChips: boolean;
  /**
   * What stands under the name. `computed`: the row's own detail line, which the
   * switches shape. `replaced`: a string of the host's (a session row's sender),
   * untouched by the switches. `hidden`: the host shows no line there.
   */
  detailLine: 'computed' | 'replaced' | 'hidden';
  /** Where the row's first column starts. See `climbRowSeparatorInset`. */
  leadingInset?: number;
};

/** The surface of a row with no host props set: what `ClimbListItemContent` defaults to. */
export const DEFAULT_CLIMB_ROW_SURFACE: ClimbRowSurface = Object.freeze({
  showAscentStatus: true,
  showPlaylistChips: false,
  detailLine: 'computed',
});

/** The text variants a row's lines are set in. */
type ClimbRowTextVariant = 'body' | 'footnote' | 'title3' | 'caption1' | 'caption2';

export type ClimbRowLayoutInput = {
  display: ClimbRowDisplay;
  surface: ClimbRowSurface;
  /** `boardSupportsMirroring` for the row's board: such a row tracks each direction on its own line. */
  supportsMirroring: boolean;
  /**
   * The system font scale (`useWindowDimensions().fontScale`), for
   * `estimatedHeight` only. Left out, the estimate is for default text. The row
   * itself passes none: it lays its lines out as real text.
   */
  fontScale?: number;
  /** False for drag-reorder hosts, whose names stay on one line. */
  allowNameWrapping?: boolean;
  /**
   * The type scale the row is drawn in (`theme.textStyles`), for
   * `estimatedHeight` only. Left out, the HIG scale: Material's line heights
   * differ by a point or two.
   */
  typeScale?: Readonly<Partial<Record<ClimbRowTextVariant, { lineHeight?: number }>>>;
};

export type ClimbRowLayout = {
  hasThumbnail: boolean;
  /** A line under the name: the computed detail line with at least one of its tokens on, or the host's own string. */
  hasDetailLine: boolean;
  /**
   * Where the community grade token goes. On the detail line while there is a
   * computed one. With sends, rating and setter all off there is no such line,
   * and the token docks at the end of the name line instead of opening a line
   * for itself. `none`: switched off, or the host replaced or hid the line.
   */
  communityGradePlace: 'detailLine' | 'nameLine' | 'none';
  /**
   * Where the flash / send / attempt mark goes: one glyph beside the grade, or
   * on a board that mirrors a status per direction on the personal line.
   */
  sentMarkPlace: 'besideGrade' | 'personalLine' | 'none';
  /** The line for what the climber did on this climb. Today that is a mirror board's direction statuses. */
  hasPersonalLine: boolean;
  hasProgressLine: boolean;
  hasTagsLine: boolean;
  /**
   * The lines whose content arrives after the row has painted (the logbook, the
   * playlist memberships) hold their space from first paint. True without a
   * thumbnail, where nothing else fixes the row's height. With one, such a line
   * grows inside the thumbnail's height and reserving it would only move text.
   */
  reservesLateLines: boolean;
  /** The row's floor: a touch target. With a thumbnail the thumbnail is taller than this. */
  minHeight: number;
  separatorInset: number;
  /**
   * The height of a row's content box, padding included and separator not, in
   * points. An estimate: late lines count as filled (with a thumbnail they may
   * not be), and what one climb adds on its own is left out (a "set at N°" line
   * under a lone grade, a row of chips for holds gone, a host's detail parts).
   */
  estimatedHeight: number;
};

function estimateClimbRowHeight(
  layout: Omit<ClimbRowLayout, 'estimatedHeight'>,
  fontScale: number,
  typeScale: ClimbRowLayoutInput['typeScale'],
  allowNameWrapping: boolean,
): number {
  const lineHeight = (variant: ClimbRowTextVariant, maxFontScale = Infinity): number =>
    (typeScale?.[variant]?.lineHeight ?? textStyles[variant].lineHeight) * Math.min(fontScale, maxFontScale);

  const lines = [lineHeight('body') * climbRowNameLines(fontScale, allowNameWrapping)];
  if (layout.hasDetailLine) lines.push(lineHeight('footnote'));
  if (layout.hasPersonalLine) {
    if (layout.hasProgressLine) lines.push(Math.max(13, lineHeight('footnote', PROGRESS_MAX_FONT_SCALE)));
    else {
      const directionHeight = Math.max(CLIMB_ROW_DIRECTION_STATUS.iconSize, lineHeight('caption2'));
      // One line for both directions where the line is reserved; one each where it is not.
      lines.push(
        layout.reservesLateLines ? directionHeight : 2 * directionHeight + CLIMB_ROW_DIRECTION_STATUS.stackedGap,
      );
    }
  }
  if (layout.hasTagsLine) {
    const chipHeight = Math.max(
      CLIMB_ROW_TAGS_LINE.chipMinHeight,
      lineHeight('caption1', CLIMB_ROW_TAGS_LINE.maxFontScale) + 2 * CLIMB_ROW_TAGS_LINE.chipPaddingVertical,
    );
    lines.push(CLIMB_ROW_TAGS_LINE.marginTop + chipHeight);
  }
  const textColumnHeight = lines.reduce((total, height) => total + height, 0) + (lines.length - 1) * CLIMB_ROW_LINE_GAP;

  const tallestColumn = Math.max(
    textColumnHeight,
    lineHeight('title3'),
    layout.hasThumbnail ? THUMBNAIL_HEIGHT : CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT,
  );
  return Math.ceil(tallestColumn + 2 * CLIMB_ROW_VERTICAL_PADDING);
}

/**
 * A climb row's structure, from what the climber switched on, what the host can
 * show and whether the board mirrors.
 *
 * Order of the text column's lines, each present or not: name, detail,
 * personal, tags.
 */
export function climbRowLayout({
  display,
  surface,
  supportsMirroring,
  fontScale = 1,
  allowNameWrapping = true,
  typeScale,
}: ClimbRowLayoutInput): ClimbRowLayout {
  const hasThumbnail = display.thumbnail;
  // Sends, rating and setter are the detail line's own tokens. The community
  // grade is a guest on it: it never opens the line by itself.
  const hasComputedDetailLine =
    surface.detailLine === 'computed' && (display.sends || display.rating || display.setter);
  const showsSentMark = surface.showAscentStatus && display.sentMark;
  const hasProgressLine = !!surface.showProgress && display.progress;
  const structure = {
    hasThumbnail,
    hasDetailLine: hasComputedDetailLine || surface.detailLine === 'replaced',
    communityGradePlace:
      surface.detailLine !== 'computed' || !display.communityGrade
        ? 'none'
        : hasComputedDetailLine
          ? 'detailLine'
          : 'nameLine',
    sentMarkPlace: !showsSentMark
      ? 'none'
      : supportsMirroring
        ? 'personalLine'
        : hasProgressLine
          ? 'none'
          : 'besideGrade',
    hasPersonalLine: hasProgressLine || (showsSentMark && supportsMirroring),
    hasProgressLine,
    hasTagsLine: surface.showPlaylistChips && display.playlistTags,
    reservesLateLines: !hasThumbnail,
    minHeight: CLIMB_ROW_MIN_HEIGHT,
    separatorInset: climbRowSeparatorInset(hasThumbnail, surface.leadingInset),
  } satisfies Omit<ClimbRowLayout, 'estimatedHeight'>;

  return { ...structure, estimatedHeight: estimateClimbRowHeight(structure, fontScale, typeScale, allowNameWrapping) };
}

export type ClimbRowReorderRow = {
  supportsMirroring: boolean;
  hasSetAngleMarker?: boolean;
  unrenderable?: boolean;
};

/** Every indexed drag row shares the tallest possible row, before personal data loads. */
export function climbRowReorderHeight({
  rows,
  fontScale = 1,
  ...input
}: Omit<ClimbRowLayoutInput, 'supportsMirroring' | 'allowNameWrapping'> & {
  rows: readonly ClimbRowReorderRow[];
}): number {
  const lineHeight = (variant: ClimbRowTextVariant) =>
    (input.typeScale?.[variant]?.lineHeight ?? textStyles[variant].lineHeight) * fontScale;
  let minimumHeight = climbRowLayout({
    ...input,
    fontScale,
    supportsMirroring: false,
    allowNameWrapping: false,
  }).estimatedHeight;
  for (const row of rows) {
    minimumHeight = Math.max(
      minimumHeight,
      climbRowLayout({
        ...input,
        fontScale,
        supportsMirroring: row.supportsMirroring,
        allowNameWrapping: false,
      }).estimatedHeight,
    );
    if (row.hasSetAngleMarker) {
      minimumHeight = Math.max(
        minimumHeight,
        lineHeight('title3') +
          lineHeight('caption2') +
          CLIMB_ROW_SET_ANGLE_MARGIN_TOP +
          CLIMB_ROW_GRADE_LINE_GAP +
          2 * CLIMB_ROW_VERTICAL_PADDING,
      );
    }
    if (row.unrenderable) {
      // Unavailable playlist rows retain the warning (up to two lines) and a 44pt remove target.
      minimumHeight = Math.max(
        minimumHeight,
        Math.max(CLIMB_ROW_MIN_HEIGHT, lineHeight('body') + 2 * lineHeight('footnote') + CLIMB_ROW_LINE_GAP) +
          2 * CLIMB_ROW_VERTICAL_PADDING,
      );
    }
  }
  return Math.ceil(minimumHeight);
}

/**
 * How many skeleton rows it takes to cover what `defaultCount` rows of the
 * default height did. The counts in the app were picked for the 112pt row with
 * a thumbnail; a row without one is as short as 44pt, and the same count would
 * leave most of the screen empty. Never fewer than `defaultCount`.
 */
export function climbRowSkeletonCount(defaultCount: number, estimatedRowHeight: number): number {
  const defaultRowHeight = THUMBNAIL_HEIGHT + 2 * CLIMB_ROW_VERTICAL_PADDING;
  if (!(estimatedRowHeight > 0)) return defaultCount;
  return Math.max(defaultCount, Math.ceil((defaultCount * defaultRowHeight) / estimatedRowHeight));
}
