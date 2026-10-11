import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useClimbRowGrade } from '../hooks/use-climb-row-grade';
import { climbStatsKnown, isProjectClimb } from '@boardsesh/play-view';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
import { DraftChip, climbChipStyles } from './DraftChip';
import { ProjectChip } from './ProjectChip';
import { ClimbPlaylistChips, type ClimbRowPlaylistChipsLeafProps } from './ClimbPlaylistChips';
import { isClimbResolved } from '../lib/queue-climb-resolution';
import { useIsClimbFavorited } from '../hooks/use-is-climb-favorited';
import { useClimbRowDisplay } from '../lib/climb-row-display-preference';
import type { ClimbRowDisplay } from '../lib/climb-row-display';
import type { IconName } from './icon-map';
import type { AscentStatusValue } from '../lib/ascent-status-utils';

// Scan-line status marker. Status is carried by glyph SHAPE in a single neutral
// grey — not a colour — so it can't be mistaken for the colour-coded grade right
// beside it, and so it stays readable for colour-blind users. ⚡ flashed,
// ✓ sent, ✗ attempted.
const ASCENT_STATUS_ICON: Record<AscentStatusValue, IconName> = {
  flash: 'flash',
  send: 'tick.outline',
  attempt: 'ascent.attempt',
};

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
// These are the props the row hands each leaf: what identifies the climb, never
// what the leaf will draw.
export type ClimbRowSubtitleLeafProps = {
  boardName: BoardName;
  layoutId: number;
  climbUuid: string;
  angle: number;
  isDraft: boolean;
  ascensionistCount: number;
  qualityAverage: string;
  setterUsername: string;
  /** The climber has the community grade switched on. The leaf still decides whether this climb has one to show. */
  showCommunityGrade: boolean;
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
};

export type ClimbRowAscentStatusLeafProps = {
  climbUuid: string;
  angle: number;
  supportsMirroring: boolean;
  /** `Climb.holdsRevisionNumber`, a primitive so the memo boundary holds. */
  holdsRevisionNumber: number | null;
};

export type ClimbRowFavoriteLeafProps = { climbUuid: string };

export type ClimbRowLeaves = Readonly<{
  Subtitle: React.ComponentType<ClimbRowSubtitleLeafProps>;
  Grade: React.ComponentType<ClimbRowGradeLeafProps>;
  AscentStatus: React.ComponentType<ClimbRowAscentStatusLeafProps>;
  Favorite: React.ComponentType<ClimbRowFavoriteLeafProps>;
  PlaylistChips: React.ComponentType<ClimbRowPlaylistChipsLeafProps>;
}>;

type ClimbListItemContentProps = {
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
  /**
   * Render the favourite heart beside the ascent status. Opt-in per surface
   * (default off) for the same reason as `showPlaylistChips`: only the main
   * climb list feeds `favoritesStore` with its visible UUIDs, so a queue or
   * session row would otherwise show a heart on the climbs you happened to
   * scroll past and nothing on the rest.
   */
  showFavorite?: boolean;
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
 * The row's logbook subscribers are this, `LiveClimbGrade` and, only while the
 * climber has the community grade switched on, `LiveCommunityGradeSubtitle`.
 * Each is its own memo boundary. The two grade leaves have to subscribe — your
 * own grade wins over the crowd's, so the number and the token beside it must
 * move when a tick lands — but keep the subscription inside these children.
 * Hoisting any of them into `ClimbListItemContent` re-renders the thumbnail and
 * name on every merge, which is the regression this boundary exists to prevent.
 */
const AscentStatusGlyph = React.memo(function AscentStatusGlyph({
  climbUuid,
  angle,
  supportsMirroring,
  holdsRevisionNumber,
}: ClimbRowAscentStatusLeafProps) {
  // Unconditional hooks keep capability changes safe. The nonmirrorable board
  // keeps its existing aggregate glyph; each mirrorable direction is independent.
  const ascentStatus = useAscentStatus(climbUuid, angle, supportsMirroring ? false : undefined, holdsRevisionNumber);
  const mirrorStatus = useAscentStatus(climbUuid, angle, true, holdsRevisionNumber);

  return (
    <ClimbAscentStatusView
      supportsMirroring={supportsMirroring}
      ascentStatus={ascentStatus}
      mirrorStatus={mirrorStatus}
    />
  );
});

export type ClimbAscentStatusViewProps = {
  supportsMirroring: boolean;
  /** The whole climb's status on a board that cannot mirror; the original direction's on one that can. */
  ascentStatus: AscentStatusValue | null;
  /** The mirrored direction's status. Drawn only on a board that mirrors. */
  mirrorStatus: AscentStatusValue | null;
};

/**
 * What `AscentStatusGlyph` draws: one glyph beside the grade, or a labelled
 * line per direction on a board that mirrors. Nothing when there is no status.
 */
export const ClimbAscentStatusView = React.memo(function ClimbAscentStatusView({
  supportsMirroring,
  ascentStatus,
  mirrorStatus,
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

  if (!ascentStatus && !mirrorStatus) return null;
  const directions = [
    { direction: 'original', status: ascentStatus, label: tSession('mobile.logbook.originalTag') },
    { direction: 'mirror', status: mirrorStatus, label: tSession('mobile.logbook.mirroredTag') },
  ];
  return (
    <View style={styles.directionStatuses}>
      {directions.map(({ direction, status, label }) =>
        status ? (
          <View
            key={direction}
            accessible
            accessibilityRole="text"
            accessibilityLabel={t('mobile.climbRow.directionStatus', {
              direction: label,
              status: statusLabels[status],
            })}
            style={styles.directionStatus}
          >
            <Icon name={ASCENT_STATUS_ICON[status]} size={12} color={systemColors.secondaryLabel} />
            <Text variant="caption2" color={systemColors.secondaryLabel}>
              {label}
            </Text>
          </View>
        ) : null,
      )}
    </View>
  );
});

const LiveClimbSubtitle = React.memo(function LiveClimbSubtitle({
  boardName,
  layoutId,
  climbUuid,
  angle,
  isDraft,
  ascensionistCount,
  qualityAverage,
  setterUsername,
  showCommunityGrade,
  difficulty,
  myDifficulty,
  boardseshDifficulty,
  boardseshConfidence,
}: ClimbRowSubtitleLeafProps) {
  // The detail line's one stats subscription. The community grade token reads its
  // difficulty from here, so switching the token on adds no stats subscriber.
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climbUuid, angle, {
    ascensionistCount,
    qualityAverage,
    difficulty,
  });

  // Switched off, the line stops here: no token, and no logbook subscription.
  if (!showCommunityGrade) {
    return (
      <ClimbSubtitleView
        isDraft={isDraft}
        ascensionistCount={liveStats.ascensionistCount}
        qualityAverage={liveStats.qualityAverage}
        setterUsername={setterUsername}
        communityGrade={null}
      />
    );
  }

  return (
    <LiveCommunityGradeSubtitle
      boardName={boardName}
      climbUuid={climbUuid}
      angle={angle}
      isDraft={isDraft}
      ascensionistCount={liveStats.ascensionistCount}
      qualityAverage={liveStats.qualityAverage}
      setterUsername={setterUsername}
      difficulty={liveStats.difficulty}
      myDifficulty={myDifficulty}
      boardseshDifficulty={boardseshDifficulty}
      boardseshConfidence={boardseshConfidence}
    />
  );
});

type LiveCommunityGradeSubtitleProps = Omit<ClimbSubtitleViewProps, 'communityGrade'> & {
  boardName: BoardName;
  climbUuid: string;
  angle: number;
  /** The community's difficulty, already live: `LiveClimbSubtitle` owns the stats subscription. */
  difficulty: string | null;
  myDifficulty: number | null | undefined;
  boardseshDifficulty: number | null;
  boardseshConfidence: string | null;
};

/**
 * The detail line with the community grade token worked out. Mounted by
 * `LiveClimbSubtitle` only while the climber has that switch on, because the
 * token depends on the climber's own grade and so on the logbook: this is the
 * detail line's one logbook subscriber, and a row with the switch off has none.
 *
 * It asks `useClimbRowGrade` the same question `LiveClimbGrade` asks, with the
 * same fields, so the token always matches the grade in the column.
 */
const LiveCommunityGradeSubtitle = React.memo(function LiveCommunityGradeSubtitle({
  boardName,
  climbUuid,
  angle,
  isDraft,
  ascensionistCount,
  qualityAverage,
  setterUsername,
  difficulty,
  myDifficulty,
  boardseshDifficulty,
  boardseshConfidence,
}: LiveCommunityGradeSubtitleProps) {
  const { communityGradeToken } = useClimbRowGrade({
    climbUuid,
    angle,
    boardName,
    difficulty,
    myDifficulty,
    boardseshDifficulty,
    boardseshConfidence,
  });

  return (
    <ClimbSubtitleView
      isDraft={isDraft}
      ascensionistCount={ascensionistCount}
      qualityAverage={qualityAverage}
      setterUsername={setterUsername}
      communityGrade={communityGradeToken}
    />
  );
});

export type ClimbSubtitleViewProps = {
  isDraft: boolean;
  ascensionistCount: number;
  qualityAverage: string | null;
  setterUsername: string;
  /**
   * The community's grade, leading the line, or null for none. Already decided
   * (`deriveClimbRowGrade`): the view draws what it is given.
   */
  communityGrade: string | null;
};

/** The line under the name that `LiveClimbSubtitle` draws: community grade · sends · quality★ · setter. */
export const ClimbSubtitleView = React.memo(function ClimbSubtitleView({
  isDraft,
  ascensionistCount,
  qualityAverage,
  setterUsername,
  communityGrade,
}: ClimbSubtitleViewProps) {
  const { t } = useTranslation('climbs');
  // A draft says so with the chip beside its name (DraftChip), not in this line.
  const sends = !isDraft && ascensionistCount > 0 ? formatSends(ascensionistCount, t) : null;
  const rating = qualityAverage != null && parseFloat(qualityAverage) > 0 ? `${formatQuality(qualityAverage)}★` : null;
  const setter = setterUsername === '' ? null : setterUsername;

  // "Project" is said of the climb: it has no sends, no rating, no setter and no
  // community grade for this line. It keys on that data, never on how many
  // tokens ended up in the line, or a climber who hides every token would read
  // "Project" on every climb.
  const nothingKnown = sends === null && rating === null && setter === null && !communityGrade;
  if (nothingKnown) {
    return (
      <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
        {t('mobile.climbRow.projectFallback')}
      </Text>
    );
  }

  const detailTokens = [sends, rating, setter].filter((token): token is string => token !== null);
  // The community grade is plain text in the line's own grey: in this row colour
  // means the big grade and nothing else. On screen it is a bare number, so a
  // screen reader gets the line with that token spelled out.
  return (
    <Text
      variant="footnote"
      numberOfLines={1}
      accessibilityLabel={
        communityGrade
          ? [t('mobile.climbRow.communityGradeAria', { grade: communityGrade }), ...detailTokens].join(' · ')
          : undefined
      }
      style={styles.subtitle}
    >
      {(communityGrade ? [communityGrade, ...detailTokens] : detailTokens).join(' · ')}
    </Text>
  );
});

const LiveClimbGrade = React.memo(function LiveClimbGrade({
  climb,
  boardName,
  layoutId,
  angle,
}: ClimbRowGradeLeafProps) {
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climb.uuid, angle, {
    ascensionistCount: climb.ascensionist_count,
    qualityAverage: climb.quality_average,
    difficulty: climb.difficulty,
  });
  // One grade in the column: yours, else Boardsesh's, else the community's. When
  // it is not the community's, that grade goes to the detail line, never under
  // this one, so nothing lands late in this column and its height never changes.
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

  return (
    <ClimbGradeView
      label={grade.label}
      color={grade.color}
      markedAsMine={grade.markedAsMine}
      isProject={isProject}
      // The grade and the send count came from a different angle than the one on
      // the wall. `statsAngle` rides the search payload, while `liveStats` overlays
      // the store keyed on the BROWSED angle. Those only disagree after the climber
      // logs the first ever tick at the browsed angle on a climb whose numbers came
      // from another one: a canonical row appears at the browsed angle and the
      // count switches to it while this marker still names the old angle, until
      // the next search refetch resolves tier 1 and drops it. Narrow,
      // self-correcting, and not worth widening the shared hook's return to
      // pre-empt.
      setAtAngle={climb.statsAngle != null && climb.statsAngle !== angle ? climb.statsAngle : null}
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
  /** The other angle the grade was read from, or null when it is the angle on the wall. */
  setAtAngle: number | null;
};

/** The grade column `LiveClimbGrade` draws. */
export const ClimbGradeView = React.memo(function ClimbGradeView({
  label,
  color,
  markedAsMine,
  isProject,
  setAtAngle,
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
      {/* Say where the numbers came from next to the grade they qualify, not in the
          subtitle. Deliberately uncoloured: in this row colour carries grade and
          nothing else. */}
      {setAtAngle !== null ? (
        <Text
          variant="caption2"
          numberOfLines={1}
          accessibilityLabel={t('mobile.climbRow.setAngleMarkerAria', { angle: setAtAngle })}
          style={[styles.setAngleMarker, { color: systemColors.secondaryLabel }]}
        >
          {t('mobile.climbRow.setAngleMarker', { angle: setAtAngle })}
        </Text>
      ) : null}
    </View>
  );
});

const LIVE_CLIMB_ROW_LEAVES: ClimbRowLeaves = {
  Subtitle: LiveClimbSubtitle,
  Grade: LiveClimbGrade,
  AscentStatus: AscentStatusGlyph,
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
 */
const ClimbListItemContent = React.memo(function ClimbListItemContent({
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
  showFavorite = false,
  display,
  leaves = LIVE_CLIMB_ROW_LEAVES,
}: ClimbListItemContentProps) {
  const { t: tSession } = useTranslation('session');
  // The row's one subscription to the Climb list settings. Its snapshot keeps its
  // identity until a switch changes, so this never re-renders a row on its own.
  const storedDisplay = useClimbRowDisplay();
  const rowDisplay = display ?? storedDisplay;
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);
  // An optional piece of the row is drawn when the surface can show it (the
  // `show*` prop) AND the climber has it switched on. One line per piece.
  const showsPlaylistTags = showPlaylistChips && rowDisplay.playlistTags;

  const subtitleDetailText = useMemo(() => {
    const parts = subtitleDetailParts?.filter((part) => part.length > 0) ?? [];
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [subtitleDetailParts]);

  // Partially-synced peer item whose climb isn't resolved yet (#2527): render an
  // "Unknown Climb" placeholder that keeps the three-block layout so the row
  // doesn't crash and its gutter/separator still line up with resolved rows.
  // useQueueResolveClimbs re-fetches the climb by uuid and swaps in the real one,
  // so this is transient for any item that carries a fetchable uuid.
  // `!climb ||` is redundant with isClimbResolved at runtime but lets TypeScript
  // narrow `climb` to non-null for the resolved render below.
  if (!climb || !isClimbResolved(climb)) {
    return (
      <>
        <View style={styles.thumbnailContainer} />
        <View style={styles.centerColumn}>
          <Text variant="body" numberOfLines={1} style={styles.climbName}>
            {tSession('mobile.queue.unknownClimb')}
          </Text>
        </View>
        <View style={styles.rightSection} />
      </>
    );
  }

  const missingHoldCount =
    typeof climb.missingHoldCount === 'number' && climb.missingHoldCount > 0 ? climb.missingHoldCount : undefined;
  const hasLostHolds = missingHoldCount !== undefined;
  const nameAttributes = (
    <>
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

  return (
    <>
      {/* Left: portrait thumbnail with ascent badge */}
      <View style={styles.thumbnailContainer}>
        <ClimbListThumbnail
          frames={climb.frames}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          mirrored={climb.mirrored ?? false}
        />
      </View>

      {/* Center: name (+ intrinsic-attribute glyphs) + subtitle */}
      <View style={styles.centerColumn}>
        <View style={styles.nameRow}>
          <Text variant="body" numberOfLines={1} style={styles.climbName}>
            {climb.name}
          </Text>
          {!hasLostHolds ? nameAttributes : null}
        </View>
        {hasLostHolds ? <View style={styles.attributesRow}>{nameAttributes}</View> : null}
        {/* The community grade token lives in the computed detail line and nowhere
            else. A host that replaces or hides that line (a session row, which
            shows the sender's name there or nothing) gets no token, on purpose:
            its row is about one tick, and has no other line to carry it. */}
        {primarySubtitleOverride === undefined ? (
          <leaves.Subtitle
            boardName={boardName}
            layoutId={layoutId}
            climbUuid={climb.uuid}
            angle={angle}
            isDraft={climb.is_draft ?? false}
            ascensionistCount={climb.ascensionist_count ?? 0}
            qualityAverage={climb.quality_average}
            setterUsername={climb.setter_username ?? ''}
            showCommunityGrade={rowDisplay.communityGrade}
            difficulty={climb.difficulty}
            myDifficulty={climb.myDifficulty}
            boardseshDifficulty={climb.boardseshDifficulty ?? null}
            boardseshConfidence={climb.boardseshConfidence ?? null}
          />
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
        {showAscentStatus && supportsMirroring ? (
          <leaves.AscentStatus
            climbUuid={climb.uuid}
            angle={angle}
            supportsMirroring={supportsMirroring}
            holdsRevisionNumber={climb.holdsRevisionNumber ?? null}
          />
        ) : null}
        {showsPlaylistTags ? <leaves.PlaylistChips climbUuid={climb.uuid} /> : null}
      </View>

      {/* Right: favourite heart + ascent-status glyph + colorized grade */}
      <View style={styles.rightSection}>
        {showFavorite ? <leaves.Favorite climbUuid={climb.uuid} /> : null}
        {showAscentStatus && !supportsMirroring ? (
          <leaves.AscentStatus
            climbUuid={climb.uuid}
            angle={angle}
            supportsMirroring={supportsMirroring}
            holdsRevisionNumber={climb.holdsRevisionNumber ?? null}
          />
        ) : null}
        <leaves.Grade climb={climb} boardName={boardName} layoutId={layoutId} angle={angle} />
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
    gap: 2,
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
  // Under the subtitle so explicit direction labels never widen the grade rail.
  directionStatuses: {
    gap: 1,
  },
  directionStatus: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 3,
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
    // Digits stack between the two lines and between rows, so a column of
    // grades scans as a column rather than jittering on each glyph width.
    fontVariant: ['tabular-nums'],
  },
  gradeTextMarked: {
    minWidth: 0,
  },
  gradeColumn: {
    alignItems: 'flex-end',
    gap: 1,
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
    marginTop: -2,
  },
});
