import React, { useMemo, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useDisplayGrade } from '../hooks/use-display-grade';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
import { ClimbPlaylistChips } from './ClimbPlaylistChips';
import { splitGradeLabel } from '@boardsesh/play-view';
import { ESTIMATE_PREFIX } from '../lib/boardsesh-grade-display';
import { isClimbResolved } from '../lib/queue-climb-resolution';
import { useIsClimbFavorited } from '../hooks/use-is-climb-favorited';
import type { IconName } from './icon-map';
import type { AscentStatusValue } from '../lib/ascent-status-utils';

/** Size of each status glyph in the rail (favourite heart, ascent status). */
const RAIL_GLYPH_SIZE = 16;
/** Gap between the rail's status glyphs and the grade. */
const RAIL_GLYPH_GAP = 6;
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
  ascensionist_count?: number | null;
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
   * Overrides the computed primary subtitle (the sends · quality★ · setter line).
   * `undefined` (default) keeps the computed line; a string replaces it; `null`
   * hides it entirely. Session rows use this to show the sender's name (multi-user)
   * or nothing (solo), having moved the setter into the detail line as "set by X".
   */
  primarySubtitleOverride?: string | null;
  /**
   * Community consensus grade (formatted), shown as a small `people`-marked
   * secondary under the main grade when it differs from the climber's logged
   * grade. The logbook passes this so a climb you under/over-graded reads clearly.
   */
  consensusGrade?: string | null;
  /**
   * True when the main grade shown IS the consensus (the climber never logged
   * their own). Marks it with the `people` glyph so it's clear it's the crowd's.
   */
  gradeIsConsensus?: boolean;
  /**
   * Render the third row of playlist-membership tags under the subtitle. Opt-in
   * per surface (default off) so only the main filtered climb list shows them —
   * the queue, session, and logbook rows that also reuse this visual stay clean.
   * The chips additionally gate on the user's "Show playlist tags" setting and on
   * fetched membership data, so passing `true` alone doesn't force them on.
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
   * Rendered UNDER the grade, inside the trailing rail, spending the vertical
   * space the rail already occupies rather than taking another 56pt of the text
   * column. The climbs list puts its ⋮ quick-actions button here.
   */
  trailingAccessory?: ReactNode;
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
const FavoriteGlyph = React.memo(function FavoriteGlyph({ climbUuid }: { climbUuid: string }) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();
  const isFavorited = useIsClimbFavorited(climbUuid);

  if (!isFavorited) return null;
  return (
    <View accessibilityRole="image" accessibilityLabel={t('mobile.climbRow.favorited')}>
      <Icon name="favorite.fill" size={RAIL_GLYPH_SIZE} color={theme.systemColors.secondaryLabel} />
    </View>
  );
});

/**
 * Isolated, memoized ascent-status glyph. It is the ONLY part of the climb row
 * that subscribes to the logbook (via `useAscentStatus` → `BoardProvider`), so a
 * tick write / logbook merge re-renders just this 16px icon — not the whole row
 * (thumbnail, name, grade). Props are primitives, so `React.memo` skips it on
 * unrelated parent re-renders. Restores the memo boundary the climbs-search
 * redesign removed when it inlined `useAscentStatus` into `ClimbListItemContent`.
 */
const AscentStatusGlyph = React.memo(function AscentStatusGlyph({
  climbUuid,
  angle,
}: {
  climbUuid: string;
  angle: number;
}) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();
  const ascentStatus = useAscentStatus(climbUuid, angle);

  // Spoken by VoiceOver/TalkBack — the only non-visual signal now colour is gone.
  // Literal keys (not a dynamic `t(...)`) so the i18n orphan checker sees them.
  const ascentStatusLabel = useMemo(() => {
    if (!ascentStatus) return undefined;
    return {
      flash: t('mobile.climbRow.ascentStatus.flash'),
      send: t('mobile.climbRow.ascentStatus.send'),
      attempt: t('mobile.climbRow.ascentStatus.attempt'),
    }[ascentStatus];
  }, [ascentStatus, t]);

  if (!ascentStatus) return null;
  return (
    <View accessibilityRole="image" accessibilityLabel={ascentStatusLabel}>
      <Icon name={ASCENT_STATUS_ICON[ascentStatus]} size={RAIL_GLYPH_SIZE} color={theme.systemColors.secondaryLabel} />
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
}: {
  boardName: BoardName;
  layoutId: number;
  climbUuid: string;
  angle: number;
  isDraft: boolean;
  ascensionistCount: number;
  qualityAverage: string;
  setterUsername: string;
}) {
  const { t } = useTranslation('climbs');
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climbUuid, angle, {
    ascensionistCount,
    qualityAverage,
  });
  const parts: string[] = [];
  if (isDraft) parts.push(t('createClimbForm.draftBadge'));
  if (!isDraft && liveStats.ascensionistCount > 0) {
    parts.push(formatSends(liveStats.ascensionistCount, t));
  }
  const liveQuality = liveStats.qualityAverage;
  if (liveQuality != null && parseFloat(liveQuality) > 0) parts.push(`${formatQuality(liveQuality)}★`);
  if (setterUsername) parts.push(setterUsername);
  const subtitle = parts.length > 0 ? parts.join(' · ') : t('mobile.climbRow.projectFallback');

  return (
    <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
      {subtitle}
    </Text>
  );
});

const LiveClimbGrade = React.memo(function LiveClimbGrade({
  climb,
  boardName,
  layoutId,
  angle,
  gradeIsConsensus,
  consensusGrade,
}: {
  climb: ClimbListItemClimb;
  boardName: BoardName;
  layoutId: number;
  angle: number;
  gradeIsConsensus: boolean;
  consensusGrade?: string | null;
}) {
  const { resolveGrade } = useDisplayGrade();
  const { systemColors } = useTheme();
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climb.uuid, angle, {
    ascensionistCount: climb.ascensionist_count,
    qualityAverage: climb.quality_average,
    difficulty: climb.difficulty,
  });
  // The canonical community difficulty may change, but the Boardsesh grade
  // fields remain authoritative when that preference is active.
  const {
    label: formattedGrade,
    color: gradeColor,
    isEstimated,
  } = resolveGrade({
    ...climb,
    difficulty: liveStats.difficulty,
  });

  // A "both" preference renders as "V10 / 7C+", which needs ~88pt at title3 —
  // more than the rail has once the status glyphs are in it, so the label
  // overflowed the row and painted over the name. Stack the two scales instead,
  // spending the rail's unused height. `splitGradeLabel` returns a single
  // element for the one-scale formats, so those rows are unchanged.
  const gradeLines = splitGradeLabel(formattedGrade);
  // `resolveDisplayGrade` marks a projected grade by prefixing the WHOLE label
  // ("≈V5 / 6C+"), so splitting it leaves the second line reading as an exact,
  // crowd-backed grade. Re-mark it: the two lines are one grade in two scales,
  // and the confidence marker belongs to the grade, not to its first spelling.
  const secondaryGradeLine =
    gradeLines.length > 1 && isEstimated && gradeLines[1] && !gradeLines[1].startsWith(ESTIMATE_PREFIX)
      ? `${ESTIMATE_PREFIX}${gradeLines[1]}`
      : gradeLines[1];

  return (
    <View style={styles.gradeColumn}>
      <View style={styles.iconGradeRow}>
        {gradeIsConsensus ? <Icon name="people" size={13} color={systemColors.secondaryLabel} /> : null}
        <Text variant="title3" numberOfLines={1} style={[styles.gradeText, { color: gradeColor }]}>
          {gradeLines[0]}
        </Text>
      </View>
      {gradeLines.length > 1 ? (
        <Text variant="caption2" numberOfLines={1} style={[styles.gradeSecondaryText, { color: gradeColor }]}>
          {secondaryGradeLine}
        </Text>
      ) : null}
      {consensusGrade ? (
        <View style={styles.iconGradeRow}>
          <Icon name="people" size={11} color={systemColors.secondaryLabel} />
          <Text
            variant="caption2"
            numberOfLines={1}
            style={[styles.consensusText, { color: systemColors.secondaryLabel }]}
          >
            {consensusGrade}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

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
  consensusGrade,
  gradeIsConsensus = false,
  showPlaylistChips = false,
  showFavorite = false,
  trailingAccessory,
}: ClimbListItemContentProps) {
  const { t: tSession } = useTranslation('session');

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
          <ClimbAttributeIcons
            benchmarkDifficulty={climb.benchmark_difficulty}
            characteristics={climb.characteristics}
            isNoMatch={climb.is_no_match}
          />
        </View>
        {primarySubtitleOverride === undefined ? (
          <LiveClimbSubtitle
            boardName={boardName}
            layoutId={layoutId}
            climbUuid={climb.uuid}
            angle={angle}
            isDraft={climb.is_draft ?? false}
            ascensionistCount={climb.ascensionist_count ?? 0}
            qualityAverage={climb.quality_average}
            setterUsername={climb.setter_username ?? ''}
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
        {showPlaylistChips ? <ClimbPlaylistChips climbUuid={climb.uuid} /> : null}
      </View>

      {/* Right rail: status glyphs + colorized grade, with any trailing
          accessory stacked beneath them in the rail's own vertical space. */}
      <View style={styles.rightSection}>
        <View style={styles.railPrimaryRow}>
          {showFavorite ? <FavoriteGlyph climbUuid={climb.uuid} /> : null}
          {showAscentStatus ? <AscentStatusGlyph climbUuid={climb.uuid} angle={angle} /> : null}
          <LiveClimbGrade
            climb={climb}
            boardName={boardName}
            layoutId={layoutId}
            angle={angle}
            gradeIsConsensus={gradeIsConsensus}
            consensusGrade={consensusGrade}
          />
        </View>
        {trailingAccessory}
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
  climbName: {
    fontWeight: '600',
    // Shrink so the name (not the trailing attribute glyphs) absorbs truncation.
    flexShrink: 1,
  },
  subtitle: {
    opacity: 0.6,
  },
  rightSection: {
    flexShrink: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
  },
  railPrimaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    alignSelf: 'stretch',
    gap: RAIL_GLYPH_GAP,
  },
  gradeText: {
    fontWeight: '700',
    textAlign: 'right',
  },
  // Takes the rail width the status glyphs don't, so a long label (`≈V16+`, or
  // either half of a stacked V/font pair) gets the whole rail on a row with no
  // glyphs instead of being held to a 40pt minimum and overflowing.
  gradeColumn: {
    flexShrink: 1,
    minWidth: 40,
    alignItems: 'flex-end',
    gap: 1,
  },
  // Matches `gradeText`. `gradeColumn` right-aligns both lines at their natural
  // width, so this is invisible until the column is squeezed — at which point
  // the shrunk box needs to know which edge its glyphs hug, same as the primary.
  gradeSecondaryText: {
    fontWeight: '700',
    textAlign: 'right',
  },
  iconGradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  consensusText: {
    fontWeight: '600',
  },
});
