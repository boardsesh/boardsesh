import React, { useMemo, type MutableRefObject } from 'react';
import type { ReadyBoardArtSource } from '../lib/board-render/ready-board-art';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useClimbRowCrowdGrade, useClimbRowGrade } from '../hooks/use-climb-row-grade';
import { useBoardseshGradesActive } from '../hooks/use-display-grade';
import { usePersonalGradesActive } from '../hooks/use-personal-grades';
import { climbStatsKnown, isProjectClimb } from '@boardsesh/play-view';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
import { DraftChip, climbChipStyles } from './DraftChip';
import { ClimbFramesBadge, isMultiFrameClimb } from './ClimbFramesBadge';
import { ProjectChip } from './ProjectChip';
import {
  ClimbPlaylistChips,
  ClimbPlaylistChipsView,
  type ClimbPlaylistChip,
  type ClimbRowPlaylistChipsLeafProps,
} from './ClimbPlaylistChips';
import { ClimbRowReservedLine } from './ClimbRowReservedLine';
import {
  CLIMB_ROW_DIRECTION_STATUS,
  CLIMB_ROW_LINE_GAP,
  CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT,
  CLIMB_ROW_SET_ANGLE_MARGIN_TOP,
  CLIMB_ROW_GRADE_LINE_GAP,
  climbRowLayout,
  climbRowNameLines,
} from './climb-row-layout';
import { isClimbResolved } from '../lib/queue-climb-resolution';
import { useIsClimbFavorited } from '../hooks/use-is-climb-favorited';
import { useClimbRowDisplay } from '../lib/climb-row-display-preference';
import type { ClimbRowDisplay } from '../lib/climb-row-display';
import { ASCENT_STATUS_ICON } from './ascent-status-icon';
import { ClimbProgressLine, ClimbProgressView, type ClimbRowProgressLeafProps } from './ClimbProgressLine';
import type { AscentStatusValue } from '../lib/ascent-status-utils';

// What the placeholder for a climb that has not resolved hands the tags line.
const NO_PLAYLIST_CHIPS: readonly ClimbPlaylistChip[] = [];

/**
 * Minimal structural climb shape this visual needs. Kept permissive so BOTH the
 * web-schema `Climb` (search list) and the `@boardsesh/queue` `Climb` (queue
 * items / playlist suggestions) satisfy it without a cast — the two declare
 * their own `Climb` types.
 */
export type ClimbListItemClimb = {
  uuid: string;
  name: string;
  frames: string;
  /** Multi-frame routes receive a fixed pip, over the picture or beside the name. */
  framesCount?: number | null;
  difficulty: string;
  mirrored?: boolean | null;
  is_draft?: boolean | null;
  /** Voted out of the browse lists by the community. Optional because the queue's
   *  own `Climb` type doesn't carry it — a queued row simply shows no chip. */
  is_hidden?: boolean | null;
  /** How many of this climb's holds are no longer on the wall — a spray wall that
   *  got reset under it (SW-13). Null on every catalogue board, where holds don't
   *  come off. Optional for the same reason as `is_hidden` above: the queue's own
   *  `Climb` type doesn't carry it, so a queued row simply shows no chip. */
  missingHoldCount?: number | null;
  /** The version at which this climb's holds last moved (#6023). A tick older
   *  than that does not mark the row sent. Null or absent on a row whose source
   *  does not carry it, where every tick counts. */
  holdsRevisionNumber?: number | null;
  ascensionist_count?: number | null;
  /** The angle the grade and send count above were read from. Present only on rows
   *  that came through a cross-angle search (issue #5405); the queue's own `Climb`
   *  does not carry it, so a queued row simply shows no marker. */
  statsAngle?: number | null;
  /** The climber's own grade, projected by a search that filtered or sorted by
   *  it (#4828). Absent on every other row, including queued ones. */
  myDifficulty?: number | null;
  quality_average: string;
  setter_username?: string | null;
  // Intrinsic climb attributes shown as grey glyphs after the name.
  is_no_match?: boolean | null;
  benchmark_difficulty?: string | null;
  characteristics?: string[] | null;
  // Boardsesh grade (data-science difficulty + confidence), carried on every climb
  // from PR #3554. Optional + permissive so both the web-schema `Climb` and the
  // `@boardsesh/queue` `Climb` satisfy this shape; `resolveGrade` renders the
  // Boardsesh grade in their place when the "Show Boardsesh grades" toggle is on.
  //
  // INVARIANT (enforced at the callers, not here): set these two fields ONLY when
  // `difficulty` above is a COMMUNITY/CONSENSUS grade — NEVER a user's own logged
  // ascent grade. `resolveGrade` swaps in the Boardsesh grade unconditionally when
  // the toggle is on, so it cannot tell the two apart; a caller that renders a
  // climber's own logged grade would silently violate the hard rule (a user grade
  // always wins) if it populated these. Such callers MUST omit them — see
  // `sessionTickToClimb`, which carries the Boardsesh fields only for an ungraded
  // tick and drops them the moment a logged grade is present.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
};

// The row's leaves. Each is two components: a VIEW that draws from plain props,
// and a live wrapper that owns the store subscriptions and renders the view.
// The row mounts the wrappers; the Climb list settings preview cannot (the stats
// hook throws outside its provider and would start network reads), so it builds
// its own leaves from the exported views and staged data and passes them in.
//
// These are the props the row hands each leaf: what identifies the climb, and
// which of the climber's switches bear on the leaf, never what the leaf will
// draw.

/**
 * Where the row mounts its detail leaf. `detailLine`: the line under the name.
 * `nameLine`: the row has no detail line (sends, rating and setter are all
 * off), and the leaf is there for the community grade alone, docked after the
 * name instead of opening a line for one token.
 */
export type ClimbRowSubtitlePlace = 'detailLine' | 'nameLine';

export type ClimbRowSubtitleLeafProps = {
  boardName: BoardName;
  layoutId: number;
  climbUuid: string;
  angle: number;
  isDraft: boolean;
  ascensionistCount: number;
  qualityAverage: string;
  setterUsername: string;
  place: ClimbRowSubtitlePlace;
  // The climber's switches for the line's three own tokens. All false on the
  // name line. Each says the token may be drawn; the leaf still decides whether
  // this climb has one.
  showSends: boolean;
  showRating: boolean;
  showSetter: boolean;
  /** The climber has the community grade switched on. The leaf still decides whether this climb has one to show. */
  showCommunityGrade: boolean;
  /**
   * The other angle the climb's grade and sends were read at, or null when it
   * is the angle on the wall. The leaf draws the marker only when the grade
   * column hands it over (see `setAngleMarkerPlace`). Always null on the name
   * line: the marker never leaves the grade column for it.
   */
  setAtAngle: number | null;
  // What the community grade token is worked out from: the same four fields the
  // grade leaf reads off the climb, as primitives so the memo boundary holds.
  difficulty: string;
  /** `Climb.myDifficulty`: undefined when the search projected none, null when it found none. */
  myDifficulty: number | null | undefined;
  boardseshDifficulty: number | null;
  boardseshConfidence: string | null;
};

export type ClimbRowGradeLeafProps = {
  climb: ClimbListItemClimb;
  boardName: BoardName;
  layoutId: number;
  angle: number;
  /** Same value the detail line gets: exactly one of the two leaves draws the marker. */
  setAtAngle: number | null;
  /**
   * The row draws its computed detail line, so the set-angle marker can move
   * there. False on a host that replaces or hides that line, and on a row whose
   * detail tokens are all switched off: the marker then has to stay under the
   * grade.
   */
  hasComputedDetailLine: boolean;
  /**
   * Keep a line under the grade on a row that has a set-angle marker, also
   * while the marker is in the detail line. The row asks for this when it has no
   * thumbnail: the marker moves once the logbook lands, and nothing else would
   * stop the row changing height when it does.
   */
  reserveSetAngleLine: boolean;
};

export type ClimbRowAscentStatusLeafProps = {
  boardName: BoardName;
  climbUuid: string;
  angle: number;
  supportsMirroring: boolean;
  /** `Climb.holdsRevisionNumber`, a primitive so the memo boundary holds. */
  holdsRevisionNumber: number | null;
  /** See `ClimbListItemContentProps.knownAscentStatus`. Absent or null: the logbook alone. */
  knownStatus?: AscentStatusValue | null;
  /**
   * On a board that mirrors: lay both directions out on ONE line and hold that
   * line while neither has a status. The row asks for this when it has no
   * thumbnail, for the reason given at `reserveSetAngleLine`.
   */
  reserveLine: boolean;
  allowLabelWrapping?: boolean;
};

export type ClimbRowFavoriteLeafProps = { climbUuid: string };

export type ClimbRowThumbnailLeafProps = {
  climbUuid?: string;
  readyBoardArtRef?: MutableRefObject<ReadyBoardArtSource | null>;
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  mirrored: boolean;
};

export type ClimbRowLeaves = Readonly<{
  Thumbnail?: React.ComponentType<ClimbRowThumbnailLeafProps>;
  Progress?: React.ComponentType<ClimbRowProgressLeafProps>;
  Subtitle: React.ComponentType<ClimbRowSubtitleLeafProps>;
  Grade: React.ComponentType<ClimbRowGradeLeafProps>;
  AscentStatus: React.ComponentType<ClimbRowAscentStatusLeafProps>;
  Favorite: React.ComponentType<ClimbRowFavoriteLeafProps>;
  PlaylistChips: React.ComponentType<ClimbRowPlaylistChipsLeafProps>;
}>;

type ClimbListItemContentProps = {
  readyBoardArtRef?: MutableRefObject<ReadyBoardArtSource | null>;
  // Nullable/thin-tolerant: the search list always supplies a resolved climb, but
  // a partially-synced peer queue item can reach the queue row with a missing or
  // unresolved climb (`ClimbQueueItem.climb` is typed non-null, yet the wire
  // boundary is untyped). When it isn't resolved we render an "Unknown Climb"
  // placeholder rather than crashing on `climb.frames`; useQueueResolveClimbs
  // then re-fetches and hydrates it in place (#2527).
  climb: ClimbListItemClimb | null | undefined;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  subtitleDetailParts?: readonly string[];
  /**
   * Whether to render the trailing ascent-status glyph. Defaults to true. Set
   * false where the host already shows the ascent status (e.g. the in-session
   * history row's leading badge) so it isn't duplicated beside the grade.
   */
  showAscentStatus?: boolean;
  /**
   * Overrides the computed primary subtitle (the community grade · sends ·
   * quality★ · setter line). `undefined` (default) keeps the computed line; a
   * string replaces it; `null` hides it entirely. Session rows use this to show
   * the sender's name (multi-user) or nothing (solo), having moved the setter
   * into the detail line as "set by X". The community grade token goes with the
   * computed line, so a row that overrides it shows none.
   */
  primarySubtitleOverride?: string | null;
  /**
   * Render the third row of playlist-membership tags under the subtitle. Opt-in
   * per surface (default off) so only the main filtered climb list shows them —
   * the queue, session, and logbook rows that also reuse this visual stay clean.
   * Passing `true` alone doesn't force them on: the row mounts the tag strip only
   * while the climber's "Show playlist tags" setting is also on, and the strip
   * draws nothing until membership data has been fetched.
   */
  showPlaylistChips?: boolean;
  /** Personal progress is opt-in for the three browse feeds; never reorder hosts. */
  showProgress?: boolean;
  /**
   * Render the favourite heart beside the ascent status. Opt-in per surface
   * (default off) for the same reason as `showPlaylistChips`: only the main
   * climb list feeds `favoritesStore` with its visible UUIDs, so a queue or
   * session row would otherwise show a heart on the climbs you happened to
   * scroll past and nothing on the rest.
   */
  showFavorite?: boolean;
  /** Drag hosts keep names on one line so every reorder step has one height. */
  allowNameWrapping?: boolean;
  /**
   * A status the host already knows from elsewhere, drawn while the logbook has
   * none for this climb: the workout preview knows a top-up came from the
   * search for sent climbs before that climb's ticks have loaded. The logbook
   * wins once it has a status. Only on a board that cannot mirror, since such a
   * status names no direction.
   */
  knownAscentStatus?: AscentStatusValue | null;
  /**
   * What the row shows. Omitted (every list does this), the row reads the
   * climber's Climb list settings itself, so no host has to thread them through.
   * Provided, it is used as given: the settings preview passes the row it is
   * staging.
   */
  display?: ClimbRowDisplay;
  /**
   * The leaf components to mount. Omitted, the live ones. Must be a stable
   * object: a new one remounts every leaf.
   */
  leaves?: ClimbRowLeaves;
};

/**
 * Isolated, memoized favourite heart. Same boundary as `AscentStatusGlyph`: the
 * only part of the row subscribed to `favoritesStore`, over a primitive uuid, so
 * favouriting one climb re-renders one 14px icon rather than every visible row.
 *
 * Same neutral grey and size as the ascent-status glyph it sits beside, for the
 * reason given above `ASCENT_STATUS_ICON`: this cluster carries meaning by glyph
 * SHAPE, leaving colour to mean grade and nothing else. A red heart here would
 * read as a third colour signal next to the colour-coded grade and would carry
 * its meaning in a way colour-blind users can't see. The filled silhouette is
 * what distinguishes it — the actions sheet keeps the red heart, where it's a
 * control rather than a scan-line marker.
 *
 * Renders nothing when the climb isn't favourited, which is the common case, so
 * it costs an unfavourited row nothing but the subscription.
 */
const FavoriteGlyph = React.memo(function FavoriteGlyph({ climbUuid }: ClimbRowFavoriteLeafProps) {
  return useIsClimbFavorited(climbUuid) ? <ClimbFavoriteView /> : null;
});

/** The heart `FavoriteGlyph` draws on a favourited climb. Props-free: it is either there or not. */
export const ClimbFavoriteView = React.memo(function ClimbFavoriteView() {
  const { t } = useTranslation('climbs');
  const theme = useTheme();

  return (
    <View accessibilityRole="image" accessibilityLabel={t('mobile.climbRow.favorited')}>
      <Icon name="favorite.fill" size={16} color={theme.systemColors.secondaryLabel} />
    </View>
  );
});

/**
 * "Hidden" chip for a climb the community voted out of the browse lists. It only
 * ever appears on the surfaces that still show such a climb — an explicit name
 * search, the setter's own climbs, a direct link — so it answers the question
 * those rows raise: why is this one no longer in the list?
 *
 * Props-free and memoized, so a row that isn't hidden pays nothing and a hidden
 * one renders the chip once per mount.
 */
const HiddenChip = React.memo(function HiddenChip() {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  return (
    <View
      style={[climbChipStyles.chip, styles.nameRowChip, { backgroundColor: systemColors.fill }]}
      accessibilityRole="text"
      accessibilityLabel={t('mobile.hidden.chip')}
      testID="climb-row-hidden-chip"
    >
      <Icon name="visibility.off" size={11} color={systemColors.secondaryLabel} />
      <Text variant="caption2" numberOfLines={1} color={systemColors.secondaryLabel}>
        {t('mobile.hidden.chip')}
      </Text>
    </View>
  );
});

/**
 * "N holds gone" chip for a climb whose spray wall was reset under it (SW-13).
 * It answers the question the row otherwise raises silently — why this climb no
 * longer works — and points at the remix flow on the climb itself.
 *
 * Not props-free like `HiddenChip`: it carries the count. The prop is a single
 * primitive, so `React.memo` still skips it on every unrelated parent re-render.
 *
 * Same neutral `fill` / `secondaryLabel` pair as `HiddenChip`, deliberately: the
 * row's one colour signal is the grade (see the note above `ASCENT_STATUS_ICON`),
 * and a warning-coloured chip here would compete with it.
 */
const LostHoldsChip = React.memo(function LostHoldsChip({ count }: { count: number }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  return (
    <View
      style={[climbChipStyles.chip, styles.nameRowChip, { backgroundColor: systemColors.fill }]}
      accessibilityRole="text"
      accessibilityLabel={t('mobile.lostHolds.chipAria', { count })}
      testID="climb-row-lost-holds-chip"
    >
      {/* Renders ✕-in-circle on both platforms — a removal marker, which is what a
          hold coming off the wall is. Named for the create-climb frame editor it
          was added for; reused here rather than minting a near-identical glyph. */}
      <Icon name="frame.remove" size={11} color={systemColors.secondaryLabel} />
      <Text variant="caption2" numberOfLines={1} color={systemColors.secondaryLabel}>
        {t('mobile.lostHolds.chip', { count })}
      </Text>
    </View>
  );
});

/**
 * Isolated, memoized ascent-status glyph, subscribed to the logbook via
 * `useAscentStatus` → `BoardProvider`, so a tick write / logbook merge
 * re-renders just the status markers. Props are primitives, so `React.memo` skips
 * it on unrelated parent re-renders. Restores the memo boundary the
 * climbs-search redesign removed when it inlined `useAscentStatus` into
 * `ClimbListItemContent`.
 *
 * The row's logbook subscribers are this, `LiveClimbGrade` and, only on a row
 * whose detail line can change with the climber's own grade, the detail leaf
 * (`useMyGradeSubtitle`). Each is its own memo boundary. The two grade leaves have
 * to subscribe — your own grade wins over the crowd's, so the number and the
 * token beside it must move when a tick lands — but keep the subscription inside
 * these children. Hoisting any of them into `ClimbListItemContent` re-renders the
 * thumbnail and name on every merge, which is the regression this boundary
 * exists to prevent.
 */
const AscentStatusGlyph = React.memo(function AscentStatusGlyph({
  boardName,
  climbUuid,
  angle,
  supportsMirroring,
  holdsRevisionNumber,
  knownStatus = null,
  reserveLine,
  allowLabelWrapping,
}: ClimbRowAscentStatusLeafProps) {
  // Unconditional hooks keep capability changes safe. The nonmirrorable board
  // keeps its existing aggregate glyph; each mirrorable direction is independent.
  const ascentStatus = useAscentStatus(
    climbUuid,
    angle,
    supportsMirroring ? false : undefined,
    holdsRevisionNumber,
    boardName,
  );
  const mirrorStatus = useAscentStatus(climbUuid, angle, true, holdsRevisionNumber, boardName);
  // A known status names no direction, so a board that mirrors keeps to the logbook.
  const shownStatus = supportsMirroring ? ascentStatus : (ascentStatus ?? knownStatus);

  return (
    <ClimbAscentStatusView
      supportsMirroring={supportsMirroring}
      ascentStatus={shownStatus}
      mirrorStatus={mirrorStatus}
      reserveLine={reserveLine}
      allowLabelWrapping={allowLabelWrapping}
    />
  );
});

export type ClimbAscentStatusViewProps = {
  supportsMirroring: boolean;
  /** The whole climb's status on a board that cannot mirror; the original direction's on one that can. */
  ascentStatus: AscentStatusValue | null;
  /** The mirrored direction's status. Drawn only on a board that mirrors. */
  mirrorStatus: AscentStatusValue | null;
  /** See `ClimbRowAscentStatusLeafProps.reserveLine`. Changes nothing on a board that cannot mirror. */
  reserveLine: boolean;
  allowLabelWrapping?: boolean;
};

/**
 * What `AscentStatusGlyph` draws: one glyph beside the grade, or a labelled
 * status per direction on a board that mirrors. Nothing when there is no
 * status, unless the line is reserved: then one line, filled or empty.
 */
export const ClimbAscentStatusView = React.memo(function ClimbAscentStatusView({
  supportsMirroring,
  ascentStatus,
  mirrorStatus,
  reserveLine,
  allowLabelWrapping = true,
}: ClimbAscentStatusViewProps) {
  const { t } = useTranslation('climbs');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const statusLabels = useMemo(
    () => ({
      flash: t('mobile.climbRow.ascentStatus.flash'),
      send: t('mobile.climbRow.ascentStatus.send'),
      attempt: t('mobile.climbRow.ascentStatus.attempt'),
    }),
    [t],
  );

  if (!supportsMirroring) {
    if (!ascentStatus) return null;
    return (
      <View accessibilityRole="image" accessibilityLabel={statusLabels[ascentStatus]}>
        <Icon name={ASCENT_STATUS_ICON[ascentStatus]} size={16} color={systemColors.secondaryLabel} />
      </View>
    );
  }

  const hasStatus = !!ascentStatus || !!mirrorStatus;
  if (!hasStatus && !reserveLine) return null;
  const directions = [
    { direction: 'original', status: ascentStatus, label: tSession('mobile.logbook.originalTag') },
    { direction: 'mirror', status: mirrorStatus, label: tSession('mobile.logbook.mirroredTag') },
  ];
  const singleLineLabels = reserveLine || !allowLabelWrapping;
  const directionStatuses = directions.map(({ direction, status, label }) =>
    status ? (
      <View
        key={direction}
        accessible
        accessibilityRole="text"
        accessibilityLabel={t('mobile.climbRow.directionStatus', {
          direction: label,
          status: statusLabels[status],
        })}
        style={singleLineLabels ? styles.directionStatusInline : styles.directionStatus}
      >
        <Icon
          name={ASCENT_STATUS_ICON[status]}
          size={CLIMB_ROW_DIRECTION_STATUS.iconSize}
          color={systemColors.secondaryLabel}
        />
        <Text
          variant="caption2"
          color={systemColors.secondaryLabel}
          // One line can only hold its height if neither label wraps.
          numberOfLines={singleLineLabels ? 1 : undefined}
          style={singleLineLabels ? styles.directionLabelInline : undefined}
        >
          {label}
        </Text>
      </View>
    ) : null,
  );

  // One line, there from the row's first paint. Empty, it is as tall as a
  // status: the same caption, and never shorter than the glyph.
  if (reserveLine) {
    return (
      <View style={styles.directionStatusLine} testID="climb-row-personal-line">
        {hasStatus ? directionStatuses : <ClimbRowReservedLine variant="caption2" />}
      </View>
    );
  }
  return <View style={styles.directionStatuses}>{directionStatuses}</View>;
});

/**
 * The row's detail leaf: the line under the name, or on a row with no such
 * line the community grade docked on the name line.
 *
 * It draws nothing itself. It picks which leaf to mount, so the row pays for
 * exactly what can change what it draws, and a switch that is off takes its
 * subscription with it:
 *
 * - The stats store is read for the sends, the rating, and the community's
 *   live difficulty while a token is worked out from it. A line that shows the
 *   setter alone mounts no stats subscriber.
 * - The logbook is read only where the climber's own grade can be in the
 *   column, which is where it can change the token or move the set-angle marker.
 */
const LiveClimbSubtitle = React.memo(function LiveClimbSubtitle(props: ClimbRowSubtitleLeafProps) {
  const { place, showSends, showRating, showCommunityGrade, setAtAngle } = props;
  // Two setting reads pick the leaf. A token needs a grade in the column that
  // is not the community's: the climber's own (personal grades) or a Boardsesh
  // grade. With neither active there is nothing to work out.
  const personalGradesActive = usePersonalGradesActive();
  const boardseshGradesActive = useBoardseshGradesActive();

  // The column can show the climber's own grade, which is in the logbook. Two
  // things here follow it: the token (while its switch is on) and, on a row read
  // at another angle, the set-angle marker, which moves to the detail line from
  // the grade column. A row with neither stays off the logbook.
  if (personalGradesActive && (showCommunityGrade || setAtAngle !== null)) {
    // The marker's place follows the climber's grade alone. With the token and
    // both numbers off, nothing on the line comes from the stats store.
    return showCommunityGrade || showSends || showRating ? (
      <LiveMyGradeSubtitle {...props} />
    ) : (
      <MyGradeMarkerSubtitle {...props} />
    );
  }

  // No grade of the climber's own can be in the column, so only a Boardsesh
  // grade there can differ from the community's. That needs no logbook.
  if (showCommunityGrade && boardseshGradesActive) return <LiveCrowdGradeSubtitle {...props} />;

  // Nothing here depends on a grade: the token is off or the column can only
  // show the community's own, and the marker stays under that grade. On the
  // name line, where the leaf is there for the token alone, that leaves nothing
  // to draw and nothing to subscribe to.
  if (place === 'nameLine') return null;
  if (showSends || showRating) return <LiveStatsSubtitle {...props} />;
  // The setter alone, which the row already has: no store is read.
  return subtitleView(props, props, null, null);
});

/** The community's numbers as a leaf below hands them to the view: live, or the row's own. */
type SubtitleNumbers = { ascensionistCount: number; qualityAverage: string | null };

/** The view, from the leaf's props, the numbers to show and the two answers a grade reader gives. */
function subtitleView(
  props: ClimbRowSubtitleLeafProps,
  numbers: SubtitleNumbers,
  communityGrade: string | null,
  setAtAngle: number | null,
) {
  return (
    <ClimbSubtitleView
      place={props.place}
      isDraft={props.isDraft}
      ascensionistCount={numbers.ascensionistCount}
      qualityAverage={numbers.qualityAverage}
      setterUsername={props.setterUsername}
      showSends={props.showSends}
      showRating={props.showRating}
      showSetter={props.showSetter}
      communityGrade={communityGrade}
      setAtAngle={setAtAngle}
    />
  );
}

/** The detail leaf's one stats subscription. The token reads its difficulty from here, so switching it on adds none. */
function useSubtitleStats(props: ClimbRowSubtitleLeafProps) {
  return useEffectiveClimbStats(props.boardName, props.layoutId, props.climbUuid, props.angle, {
    ascensionistCount: props.ascensionistCount,
    qualityAverage: props.qualityAverage,
    difficulty: props.difficulty,
  });
}

/**
 * What the climber's own grade decides for the detail leaf: the token, and
 * whether the set-angle marker is drawn here. This is the detail leaf's one
 * LOGBOOK subscription, so only the two leaves below call it, and
 * `LiveClimbSubtitle` mounts them only where the answer can change what the
 * line draws.
 *
 * It asks `useClimbRowGrade` the same question `LiveClimbGrade` asks, with the
 * same fields, so the token and the marker always match the grade in the column.
 */
function useMyGradeSubtitle(props: ClimbRowSubtitleLeafProps, communityDifficulty: string | null) {
  const { communityGradeToken, setAngleMarkerPlace } = useClimbRowGrade({
    climbUuid: props.climbUuid,
    angle: props.angle,
    boardName: props.boardName,
    difficulty: communityDifficulty,
    myDifficulty: props.myDifficulty,
    boardseshDifficulty: props.boardseshDifficulty,
    boardseshConfidence: props.boardseshConfidence,
  });

  return {
    communityGrade: props.showCommunityGrade ? communityGradeToken : null,
    setAtAngle: setAngleMarkerPlace === 'detailLine' ? props.setAtAngle : null,
  };
}

/** The detail leaf on a row whose column can show the climber's own grade: the stats store and the logbook. */
const LiveMyGradeSubtitle = React.memo(function LiveMyGradeSubtitle(props: ClimbRowSubtitleLeafProps) {
  const liveStats = useSubtitleStats(props);
  const { communityGrade, setAtAngle } = useMyGradeSubtitle(props, liveStats.difficulty);

  return subtitleView(props, liveStats, communityGrade, setAtAngle);
});

/**
 * The same row with the token and both numbers switched off: the logbook, for
 * the marker's place, and no stats store. The difficulty handed over is the
 * row's own; the marker's place does not depend on it.
 */
const MyGradeMarkerSubtitle = React.memo(function MyGradeMarkerSubtitle(props: ClimbRowSubtitleLeafProps) {
  const { communityGrade, setAtAngle } = useMyGradeSubtitle(props, props.difficulty);

  return subtitleView(props, props, communityGrade, setAtAngle);
});

/**
 * The detail leaf on a row whose column can show a Boardsesh grade but never
 * the climber's own. Same rule as `LiveMyGradeSubtitle`, with no logbook: a tick
 * landing re-renders nothing here. The set-angle marker never comes to this
 * line, because it only leaves the grade column for the climber's own grade.
 */
const LiveCrowdGradeSubtitle = React.memo(function LiveCrowdGradeSubtitle(props: ClimbRowSubtitleLeafProps) {
  const liveStats = useSubtitleStats(props);
  const { communityGradeToken } = useClimbRowCrowdGrade({
    boardName: props.boardName,
    difficulty: liveStats.difficulty,
    boardseshDifficulty: props.boardseshDifficulty,
    boardseshConfidence: props.boardseshConfidence,
  });

  return subtitleView(props, liveStats, communityGradeToken, null);
});

/** The detail line with sends or rating on it and no grade to work out: the stats store, and nothing else. */
const LiveStatsSubtitle = React.memo(function LiveStatsSubtitle(props: ClimbRowSubtitleLeafProps) {
  return subtitleView(props, useSubtitleStats(props), null, null);
});

export type ClimbSubtitleViewProps = {
  /** See `ClimbRowSubtitlePlace`. On the name line the view draws the community grade and nothing else. */
  place: ClimbRowSubtitlePlace;
  isDraft: boolean;
  ascensionistCount: number;
  qualityAverage: string | null;
  setterUsername: string;
  // The climber's switches for the line's three own tokens.
  showSends: boolean;
  showRating: boolean;
  showSetter: boolean;
  /**
   * The community's grade for this line, or null for none. Already decided
   * (`deriveClimbRowGrade`): the view draws what it is given.
   */
  communityGrade: string | null;
  /**
   * The other angle the community's numbers were read at, when that marker
   * belongs on this line instead of under the grade. Null otherwise. Already
   * decided, like `communityGrade`.
   */
  setAtAngle: number | null;
};

/**
 * What `LiveClimbSubtitle` draws. As the line under the name:
 * set at N° · community grade · sends · quality★ · setter, each of the last
 * three only while its switch is on. Docked on the name line: the community
 * grade alone, or nothing.
 */
export const ClimbSubtitleView = React.memo(function ClimbSubtitleView({
  place,
  isDraft,
  ascensionistCount,
  qualityAverage,
  setterUsername,
  showSends,
  showRating,
  showSetter,
  communityGrade,
  setAtAngle,
}: ClimbSubtitleViewProps) {
  const { t } = useTranslation('climbs');

  // The same token as in the detail line, in the same grey, after the name and
  // its glyphs. It is not a line: a climb without one draws nothing here.
  if (place === 'nameLine') {
    if (!communityGrade) return null;
    return (
      <Text
        variant="footnote"
        numberOfLines={1}
        accessibilityLabel={t('mobile.climbRow.communityGradeAria', { grade: communityGrade })}
        style={[styles.subtitle, styles.dockedCommunityGrade]}
      >
        {communityGrade}
      </Text>
    );
  }

  // A draft says so with the chip beside its name (DraftChip), not in this line.
  const sends = !isDraft && ascensionistCount > 0 ? formatSends(ascensionistCount, t) : null;
  const rating = qualityAverage != null && parseFloat(qualityAverage) > 0 ? `${formatQuality(qualityAverage)}★` : null;
  const setter = setterUsername === '' ? null : setterUsername;

  // "Project" is said of the climb: it has no sends, no rating, no setter and
  // nothing about its grade for this line. It keys on that data, never on how
  // many tokens ended up in the line, or a climber who hides every token would
  // read "Project" on every climb. It stands in for the send count, so it goes
  // when the climber switches sends off.
  const nothingKnown = sends === null && rating === null && setter === null && !communityGrade && setAtAngle === null;
  if (showSends && nothingKnown) {
    return (
      <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
        {t('mobile.climbRow.projectFallback')}
      </Text>
    );
  }

  // Each token as drawn, and as spoken where the two differ. All of it is plain
  // text in the line's own grey: in this row colour means the big grade and
  // nothing else.
  const tokens: { drawn: string; spoken?: string }[] = [];
  // The set-angle marker LEADS the line. The line is cut from its end when it
  // does not fit, so a marker in front is still there for as long as any number
  // it qualifies is. Behind them, a narrow row would cut the marker first and
  // leave another angle's grade and sends reading as this angle's.
  if (setAtAngle !== null) {
    tokens.push({
      drawn: t('mobile.climbRow.setAngleMarker', { angle: setAtAngle }),
      spoken: t('mobile.climbRow.setAngleMarkerAria', { angle: setAtAngle }),
    });
  }
  // On screen the community grade is a bare number, so a screen reader gets it
  // spelled out.
  if (communityGrade) {
    tokens.push({ drawn: communityGrade, spoken: t('mobile.climbRow.communityGradeAria', { grade: communityGrade }) });
  }
  const stats = [showSends ? sends : null, showRating ? rating : null, showSetter ? setter : null];
  for (const stat of stats) if (stat !== null) tokens.push({ drawn: stat });

  // Every token this climb has is switched off, or it has none of the ones
  // that are on. The line is part of the row's shape, not of this climb's data,
  // so it stays, empty: names line up down the list and every row is one height.
  if (tokens.length === 0) return <ClimbRowReservedLine variant="footnote" />;

  return (
    <Text
      variant="footnote"
      numberOfLines={1}
      accessibilityLabel={
        tokens.some((token) => token.spoken !== undefined)
          ? tokens.map((token) => token.spoken ?? token.drawn).join(' · ')
          : undefined
      }
      style={styles.subtitle}
    >
      {tokens.map((token) => token.drawn).join(' · ')}
    </Text>
  );
});

const LiveClimbGrade = React.memo(function LiveClimbGrade({
  climb,
  boardName,
  layoutId,
  angle,
  setAtAngle,
  hasComputedDetailLine,
  reserveSetAngleLine,
}: ClimbRowGradeLeafProps) {
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climb.uuid, angle, {
    ascensionistCount: climb.ascensionist_count,
    qualityAverage: climb.quality_average,
    difficulty: climb.difficulty,
  });
  // One grade in the column: yours, else Boardsesh's, else the community's. When
  // it is not the community's, that grade goes to the detail line, never under
  // this one, so no second grade lands late in this column.
  const grade = useClimbRowGrade({
    climbUuid: climb.uuid,
    angle,
    boardName,
    difficulty: liveStats.difficulty,
    myDifficulty: climb.myDifficulty,
    boardseshDifficulty: climb.boardseshDifficulty,
    boardseshConfidence: climb.boardseshConfidence,
  });
  // Nobody has graded it yet (#5971): the grade's slot says so instead of
  // standing empty.
  const isProject = isProjectClimb({
    gradeLabel: grade.label,
    isDraft: climb.is_draft,
    statsKnown: climbStatsKnown(boardName, climb.statsAngle),
  });
  // The set-angle marker is about the community's numbers. Under the climber's
  // own grade, logged at the angle on the wall, it would say the wrong thing, so
  // it goes to the detail line beside those numbers. A row with no computed
  // detail line has nowhere else to put it and keeps it here.
  const marksSetAngleHere = grade.setAngleMarkerPlace === 'gradeColumn' || !hasComputedDetailLine;

  return (
    <ClimbGradeView
      label={grade.label}
      color={grade.color}
      markedAsMine={grade.markedAsMine}
      isProject={isProject}
      setAtAngle={marksSetAngleHere ? setAtAngle : null}
      reserveSetAngleLine={reserveSetAngleLine && setAtAngle !== null}
    />
  );
});

export type ClimbGradeViewProps = {
  /** The one grade in the column, already resolved: yours, else Boardsesh's, else the community's. */
  label: string;
  color: string;
  /** One head beside the grade: it is the climber's own. */
  markedAsMine: boolean;
  /** Nobody has graded it: the slot says Project instead of standing empty. */
  isProject: boolean;
  /**
   * The other angle this grade was read at, drawn as a marker under it. Null
   * when it is the angle on the wall, and when the marker sits in the detail line
   * instead (the column shows the climber's own grade).
   */
  setAtAngle: number | null;
  /**
   * The row has a set-angle marker and keeps its line here even while the
   * marker is drawn in the detail line: an empty line when `setAtAngle` is null.
   * See `ClimbRowGradeLeafProps.reserveSetAngleLine`.
   */
  reserveSetAngleLine: boolean;
};

/** The grade column `LiveClimbGrade` draws. */
export const ClimbGradeView = React.memo(function ClimbGradeView({
  label,
  color,
  markedAsMine,
  isProject,
  setAtAngle,
  reserveSetAngleLine,
}: ClimbGradeViewProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('climbs');

  return (
    <View style={styles.gradeColumn}>
      <View style={styles.iconGradeRow}>
        {markedAsMine ? <Icon name="person" size={13} color={systemColors.secondaryLabel} /> : null}
        {isProject ? (
          <ProjectChip testID="climb-row-project-chip" />
        ) : (
          <Text
            variant="title3"
            numberOfLines={1}
            // The glyph supplies the column floor when it renders, so the minimum
            // width is only needed on an unmarked row. Without this a marked row
            // would cost the climb name the full glyph width on top of a gutter
            // it no longer needs.
            style={[styles.gradeText, markedAsMine ? styles.gradeTextMarked : null, { color }]}
          >
            {label}
          </Text>
        )}
      </View>
      {/* Say where the numbers came from next to the grade they qualify.
          Deliberately uncoloured: in this row colour carries grade and nothing
          else. */}
      {setAtAngle !== null ? (
        <Text
          variant="caption2"
          numberOfLines={1}
          accessibilityLabel={t('mobile.climbRow.setAngleMarkerAria', { angle: setAtAngle })}
          style={[styles.setAngleMarker, { color: systemColors.secondaryLabel }]}
        >
          {t('mobile.climbRow.setAngleMarker', { angle: setAtAngle })}
        </Text>
      ) : reserveSetAngleLine ? (
        <ClimbRowReservedLine variant="caption2" style={styles.setAngleMarker} />
      ) : null}
    </View>
  );
});

const LIVE_CLIMB_ROW_LEAVES: ClimbRowLeaves = {
  Subtitle: LiveClimbSubtitle,
  Grade: LiveClimbGrade,
  AscentStatus: AscentStatusGlyph,
  Progress: ClimbProgressLine,
  Favorite: FavoriteGlyph,
  PlaylistChips: ClimbPlaylistChips,
};

/**
 * The shared visual of a climb list item: portrait thumbnail (with ascent
 * badge) + name/subtitle + colorized grade. Returns the three blocks as a
 * fragment so the host row owns the flex container (padding, gap, background,
 * selected/dimmed overlays) — this keeps `ClimbListRow`'s search-list layout
 * byte-for-byte identical while letting the queue row reuse the same visual
 * around its own position indicator and trailing actions.
 *
 * With the thumbnail switched off the fragment is two blocks, and the text
 * column starts where the host's row does.
 */
const ClimbListItemContent = React.memo(function ClimbListItemContent({
  readyBoardArtRef,
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  subtitleDetailParts,
  showAscentStatus = true,
  primarySubtitleOverride,
  showPlaylistChips = false,
  showProgress = false,
  showFavorite = false,
  allowNameWrapping = true,
  knownAscentStatus = null,
  display,
  leaves = LIVE_CLIMB_ROW_LEAVES,
}: ClimbListItemContentProps) {
  const { t: tSession } = useTranslation('session');
  const { fontScale } = useWindowDimensions();
  const nameLines = climbRowNameLines(fontScale, allowNameWrapping);
  const { textStyles: rowTextStyles } = useTheme();
  const nameStyle =
    nameLines === 2
      ? [styles.climbName, { minHeight: (rowTextStyles.body.lineHeight ?? 22) * fontScale * 2 }]
      : styles.climbName;
  const Thumbnail = leaves.Thumbnail ?? ClimbListThumbnail;
  const Progress = leaves.Progress ?? ClimbProgressLine;
  // The row's one subscription to the Climb list settings. Its snapshot keeps its
  // identity until a switch changes, so this never re-renders a row on its own.
  const storedDisplay = useClimbRowDisplay();
  const rowDisplay = display ?? storedDisplay;
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);
  // Everything optional about the row is decided here, once: each piece is drawn
  // when the host can show it (a `show*` prop) AND the climber has it switched
  // on. Below, an element is mounted on one condition read off this answer, and
  // an element that is not mounted holds no subscription.
  const layout = climbRowLayout({
    display: rowDisplay,
    surface: {
      showAscentStatus,
      showPlaylistChips,
      showProgress,
      detailLine: primarySubtitleOverride === undefined ? 'computed' : primarySubtitleOverride ? 'replaced' : 'hidden',
    },
    supportsMirroring,
  });
  // With a thumbnail, its 96pt is the row's floor and a line that loads late
  // grows inside it. Without one the text column carries the floor, and a late
  // line holds its space from the first paint (`layout.reservesLateLines`).
  const textColumnStyle = layout.hasThumbnail
    ? styles.centerColumn
    : [styles.centerColumn, styles.centerColumnWithoutThumbnail];

  const subtitleDetailText = useMemo(() => {
    const parts = subtitleDetailParts?.filter((part) => part.length > 0) ?? [];
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [subtitleDetailParts]);

  // Partially-synced peer item whose climb isn't resolved yet (#2527): render an
  // "Unknown Climb" placeholder that keeps the row's blocks so the row
  // doesn't crash and its gutter/separator still line up with resolved rows.
  // useQueueResolveClimbs re-fetches the climb by uuid and swaps in the real one,
  // so this is transient for any item that carries a fetchable uuid.
  // `!climb ||` is redundant with isClimbResolved at runtime but lets TypeScript
  // narrow `climb` to non-null for the resolved render below.
  if (!climb || !isClimbResolved(climb)) {
    return (
      <>
        {layout.hasThumbnail ? <View style={styles.thumbnailContainer} /> : null}
        <View style={textColumnStyle}>
          <Text variant="body" numberOfLines={nameLines} style={nameStyle}>
            {tSession('mobile.queue.unknownClimb')}
          </Text>
          {/* Without a thumbnail, hold the lines the resolved row will have, so
              the row does not change height when its climb lands. */}
          {layout.reservesLateLines && layout.hasDetailLine ? <ClimbRowReservedLine variant="footnote" /> : null}
          {layout.reservesLateLines && layout.hasProgressLine ? (
            <ClimbProgressView
              progress={null}
              supportsMirroring={supportsMirroring}
              showDirectionStatuses={false}
              reserveLine
            />
          ) : layout.reservesLateLines && layout.hasPersonalLine ? (
            <ClimbAscentStatusView supportsMirroring ascentStatus={null} mirrorStatus={null} reserveLine />
          ) : null}
          {layout.reservesLateLines && layout.hasTagsLine ? (
            <ClimbPlaylistChipsView chips={NO_PLAYLIST_CHIPS} reserveLine />
          ) : null}
        </View>
        <View style={styles.rightSection}>
          {layout.reservesLateLines ? <ClimbRowReservedLine variant="title3" /> : null}
        </View>
      </>
    );
  }

  const missingHoldCount =
    typeof climb.missingHoldCount === 'number' && climb.missingHoldCount > 0 ? climb.missingHoldCount : undefined;
  // The grade and the send count came from a different angle than the one on
  // the wall. `statsAngle` rides the search payload, while the leaves' live stats
  // overlay the store keyed on the BROWSED angle. Those only disagree after the
  // climber logs the first ever tick at the browsed angle on a climb whose
  // numbers came from another one: a canonical row appears at the browsed angle
  // and the count switches to it while this marker still names the old angle,
  // until the next search refetch resolves tier 1 and drops it. Narrow,
  // self-correcting, and not worth widening the shared hook's return to pre-empt.
  //
  // Worked out here, from what the row has at mount, and handed to both leaves
  // that can draw the marker. Which of the two draws it follows the grade in the
  // column, so it can move once when a tick lands. Neither place adds a line to
  // the text column: under the grade it is the grade column's second line, and
  // in the detail line it is one more token in a line that stays one line.
  const setAtAngle = climb.statsAngle != null && climb.statsAngle !== angle ? climb.statsAngle : null;
  const hasComputedDetailLine = primarySubtitleOverride === undefined;
  // Where the computed detail leaf goes, if anywhere: its own line, or with
  // sends, rating and setter all off the name line, for the community grade
  // alone. A host that replaces or hides the line gets neither, on purpose: its
  // row is about one tick, and has no other line to carry the token.
  const subtitlePlace: ClimbRowSubtitlePlace | null = !hasComputedDetailLine
    ? null
    : layout.hasDetailLine
      ? 'detailLine'
      : layout.communityGradePlace === 'nameLine'
        ? 'nameLine'
        : null;
  const hasLostHolds = missingHoldCount !== undefined;
  const separateAttributesLine = hasLostHolds && allowNameWrapping;
  const nameAttributes = (
    <>
      {!layout.hasThumbnail && isMultiFrameClimb(climb.framesCount) ? (
        <ClimbFramesBadge framesCount={climb.framesCount} placement="inline" />
      ) : null}
      <ClimbAttributeIcons
        benchmarkDifficulty={climb.benchmark_difficulty}
        characteristics={climb.characteristics}
        isNoMatch={climb.is_no_match}
      />
      {climb.is_draft === true ? <DraftChip style={styles.nameRowChip} testID="climb-row-draft-chip" /> : null}
      {climb.is_hidden ? <HiddenChip /> : null}
      {hasLostHolds ? <LostHoldsChip count={missingHoldCount} /> : null}
    </>
  );
  const subtitle =
    subtitlePlace === null ? null : (
      <leaves.Subtitle
        boardName={boardName}
        layoutId={layoutId}
        climbUuid={climb.uuid}
        angle={angle}
        isDraft={climb.is_draft ?? false}
        ascensionistCount={climb.ascensionist_count ?? 0}
        qualityAverage={climb.quality_average}
        setterUsername={climb.setter_username ?? ''}
        place={subtitlePlace}
        showSends={rowDisplay.sends}
        showRating={rowDisplay.rating}
        showSetter={rowDisplay.setter}
        showCommunityGrade={layout.communityGradePlace === subtitlePlace}
        setAtAngle={subtitlePlace === 'detailLine' ? setAtAngle : null}
        difficulty={climb.difficulty}
        myDifficulty={climb.myDifficulty}
        boardseshDifficulty={climb.boardseshDifficulty ?? null}
        boardseshConfidence={climb.boardseshConfidence ?? null}
      />
    );
  const ascentStatus =
    layout.sentMarkPlace === 'none' || layout.hasProgressLine ? null : (
      <leaves.AscentStatus
        boardName={boardName}
        climbUuid={climb.uuid}
        angle={angle}
        supportsMirroring={supportsMirroring}
        holdsRevisionNumber={climb.holdsRevisionNumber ?? null}
        knownStatus={knownAscentStatus}
        reserveLine={layout.reservesLateLines}
        allowLabelWrapping={allowNameWrapping}
      />
    );

  return (
    <>
      {/* Left: portrait thumbnail with ascent badge */}
      {layout.hasThumbnail ? (
        <View style={styles.thumbnailContainer}>
          <Thumbnail
            climbUuid={climb.uuid}
            readyBoardArtRef={readyBoardArtRef}
            frames={climb.frames}
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            mirrored={climb.mirrored ?? false}
          />
          {isMultiFrameClimb(climb.framesCount) ? <ClimbFramesBadge framesCount={climb.framesCount} /> : null}
        </View>
      ) : null}

      {/* Center: name (+ intrinsic-attribute glyphs), then the detail, personal and tags lines */}
      <View style={textColumnStyle}>
        <View style={styles.nameRow}>
          <Text variant="body" numberOfLines={nameLines} style={nameStyle}>
            {climb.name}
          </Text>
          {!separateAttributesLine ? nameAttributes : null}
          {subtitlePlace === 'nameLine' ? subtitle : null}
        </View>
        {separateAttributesLine ? <View style={styles.attributesRow}>{nameAttributes}</View> : null}
        {subtitlePlace === 'detailLine' ? (
          subtitle
        ) : primarySubtitleOverride ? (
          <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
            {primarySubtitleOverride}
          </Text>
        ) : null}
        {subtitleDetailText ? (
          <Text variant="caption1" numberOfLines={1} style={styles.subtitle}>
            {subtitleDetailText}
          </Text>
        ) : null}
        {layout.hasProgressLine ? (
          <Progress
            boardName={boardName}
            climbUuid={climb.uuid}
            angle={angle}
            holdsRevisionNumber={climb.holdsRevisionNumber ?? null}
            supportsMirroring={supportsMirroring}
            showDirectionStatuses={layout.sentMarkPlace === 'personalLine'}
            reserveLine={layout.reservesLateLines}
          />
        ) : layout.sentMarkPlace === 'personalLine' ? (
          ascentStatus
        ) : null}
        {layout.hasTagsLine ? (
          <leaves.PlaylistChips climbUuid={climb.uuid} reserveLine={layout.reservesLateLines} />
        ) : null}
      </View>

      {/* Right: favourite heart + ascent-status glyph + colorized grade */}
      <View style={styles.rightSection}>
        {showFavorite ? <leaves.Favorite climbUuid={climb.uuid} /> : null}
        {layout.sentMarkPlace === 'besideGrade' ? ascentStatus : null}
        <leaves.Grade
          climb={climb}
          boardName={boardName}
          layoutId={layoutId}
          angle={angle}
          setAtAngle={setAtAngle}
          hasComputedDetailLine={subtitlePlace === 'detailLine'}
          reserveSetAngleLine={layout.reservesLateLines}
        />
      </View>
    </>
  );
});

export { ClimbListItemContent };

const styles = StyleSheet.create({
  thumbnailContainer: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    flexShrink: 0,
    position: 'relative',
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: CLIMB_ROW_LINE_GAP,
  },
  // No thumbnail, so nothing else keeps a row with one short line of text as
  // tall as a touch target.
  centerColumnWithoutThumbnail: {
    minHeight: CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  attributesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 2,
  },
  climbName: {
    fontWeight: '600',
    // Shrink so the name (not the trailing attribute glyphs) absorbs truncation.
    flexShrink: 1,
  },
  // The chip shape itself is `climbChipStyles.chip`, shared with DraftChip; this
  // is only where a chip sits in the name row.
  nameRowChip: {
    marginStart: 6,
  },
  subtitle: {
    opacity: 0.6,
  },
  // The community grade at the end of the name line. Like the chips there it
  // never absorbs the row's truncation: the climb name does.
  dockedCommunityGrade: {
    marginStart: 6,
    flexShrink: 0,
  },
  // Under the subtitle so explicit direction labels never widen the grade rail.
  directionStatuses: {
    gap: CLIMB_ROW_DIRECTION_STATUS.stackedGap,
  },
  directionStatus: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 3,
  },
  // The same two statuses on one line, for a row with no thumbnail. The floor is
  // the glyph's size, so the line is one height with a status in it or without.
  directionStatusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CLIMB_ROW_DIRECTION_STATUS.inlineGap,
    minHeight: CLIMB_ROW_DIRECTION_STATUS.iconSize,
    overflow: 'hidden',
  },
  directionStatusInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 1,
    minWidth: 0,
  },
  directionLabelInline: {
    flexShrink: 1,
  },
  rightSection: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  gradeText: {
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'right',
    // Digits stack from one row to the next, so a column of
    // grades scans as a column rather than jittering on each glyph width.
    fontVariant: ['tabular-nums'],
  },
  gradeTextMarked: {
    minWidth: 0,
  },
  gradeColumn: {
    alignItems: 'flex-end',
    gap: CLIMB_ROW_GRADE_LINE_GAP,
  },
  iconGradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  setAngleMarker: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    // Pull the marker up under the grade it qualifies: the two lines read as one
    // grade block rather than two unrelated rows.
    marginTop: CLIMB_ROW_SET_ANGLE_MARGIN_TOP,
  },
});
