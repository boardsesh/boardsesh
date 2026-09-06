import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import {
  COMPACT_THUMBNAIL_HEIGHT,
  COMPACT_THUMBNAIL_WIDTH,
  thumbnailSizeForDensity,
  type ClimbListDensity,
} from './climb-list-thumbnail-metrics';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useDisplayGrade } from '../hooks/use-display-grade';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
import { ClimbFramesBadge, isMultiFrameClimb } from './ClimbFramesBadge';
import { ClimbPlaylistChips } from './ClimbPlaylistChips';
import { isClimbResolved } from '../lib/queue-climb-resolution';
import { useIsClimbFavorited } from '../hooks/use-is-climb-favorited';
import type { IconName } from './icon-map';
import type { AscentStatusValue } from '../lib/ascent-status-utils';

// Scan-line status marker. Status is carried by glyph SHAPE in a single neutral
// grey — not a colour — so it can't be mistaken for the colour-coded grade right
// beside it, and so it stays readable for colour-blind users. ⚡ flashed,
// ✓ sent, ✗ attempted.
// Hoisted so the compact tier hands `ClimbListThumbnail` a referentially stable
// `size` — a fresh object per render would break its `React.memo` on every row.
const COMPACT_THUMBNAIL_SIZE = thumbnailSizeForDensity('compact');

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
  /**
   * How many frames the climb has. Above 1 the climb is a ROUTE, and the row marks
   * it with a pip over the thumbnail — both because a mixed boulders + routes
   * filter otherwise gives you no way to tell them apart, and because the artwork
   * only ever draws the FIRST frame, which makes a good route look sparse (#4635).
   *
   * Optional + permissive for the same reason as the Boardsesh grade fields below:
   * both the web-schema `Climb` and the `@boardsesh/queue` `Climb` declare it as
   * `number | null`, and this shape has to accept both without a cast. Absent on
   * the tick-sourced rows that build a climb from a logbook entry, which simply
   * show no pip.
   */
  framesCount?: number | null;
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
   * How much of the climb this row shows — the climbs list's user-selectable
   * density (More → Climb list). Defaults to `'default'`, which is today's row
   * byte-for-byte, so every OTHER surface that renders this visual (queue,
   * session, logbook, playlist detail, profile climbs, board-presence, the
   * actions-sheet preview card) is untouched by simply not passing it.
   *
   * - `compact` — 56×72 thumbnail, no subtitle, no playlist tags.
   * - `default` — unchanged.
   * - `rich` — the playlist tags always show, whatever `showPlaylistChips` says.
   */
  density?: ClimbListDensity;
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
      <Icon name="favorite.fill" size={16} color={theme.systemColors.secondaryLabel} />
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
      <Icon name={ASCENT_STATUS_ICON[ascentStatus]} size={16} color={theme.systemColors.secondaryLabel} />
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
  const { label: formattedGrade, color: gradeColor } = resolveGrade({
    ...climb,
    difficulty: liveStats.difficulty,
  });

  return (
    <View style={styles.gradeColumn}>
      <View style={styles.iconGradeRow}>
        {gradeIsConsensus ? <Icon name="people" size={13} color={systemColors.secondaryLabel} /> : null}
        <Text variant="title3" numberOfLines={1} style={[styles.gradeText, { color: gradeColor }]}>
          {formattedGrade}
        </Text>
      </View>
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
  density = 'default',
}: ClimbListItemContentProps) {
  const { t: tSession } = useTranslation('session');

  const isCompact = density === 'compact';
  // Two StyleSheet entries picked by a ternary, not an inline object: an inline
  // style would allocate a new object on every row render and defeat the memo
  // boundaries below it.
  const thumbnailContainerStyle = isCompact ? styles.compactThumbnailContainer : styles.thumbnailContainer;
  // `size` is omitted (not computed) for the 76×96 tiers so the default row hands
  // `ClimbListThumbnail` exactly the props it got before this prop existed.
  const thumbnailSize = isCompact ? COMPACT_THUMBNAIL_SIZE : undefined;
  // The rich tier IS the opt-in to the tag line, so it shows the tags whatever the
  // "Show playlist tags" toggle says; that toggle still governs the default tier.
  const isRich = density === 'rich';
  const showChips = !isCompact && (isRich || showPlaylistChips);

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
        <View style={thumbnailContainerStyle} />
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
      <View style={thumbnailContainerStyle}>
        <ClimbListThumbnail
          frames={climb.frames}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          mirrored={climb.mirrored ?? false}
          size={thumbnailSize}
        />
        {/* Absolutely-positioned child of the (already `position: 'relative'`)
            thumbnail cell, so the pip costs the row no extra layout box. Mounted
            only for a route: the badge calls `useTranslation`, and a hook can't be
            skipped from inside, so mounting it on every row would put an i18n
            listener on every row in the list. */}
        {isMultiFrameClimb(climb.framesCount) ? (
          <ClimbFramesBadge framesCount={climb.framesCount ?? 0} compact={isCompact} />
        ) : null}
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
        {/* Compact drops the whole subtitle line — and with it `LiveClimbSubtitle`'s
            per-row `useEffectiveClimbStats` subscription, so a compact row costs
            strictly less than a default one rather than just looking smaller. */}
        {isCompact ? null : primarySubtitleOverride === undefined ? (
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
        {subtitleDetailText && !isCompact ? (
          <Text variant="caption1" numberOfLines={1} style={styles.subtitle}>
            {subtitleDetailText}
          </Text>
        ) : null}
        {showChips ? <ClimbPlaylistChips climbUuid={climb.uuid} forceVisible={isRich} /> : null}
      </View>

      {/* Right: favourite heart + ascent-status glyph + colorized grade */}
      <View style={styles.rightSection}>
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
  // The compact tier's cell. This is what actually shrinks the row: 72 + 8 + 8 of
  // padding = an 88pt row, against the default's 96 + 16 = 112pt. Dropping text
  // lines alone would save nothing, because the thumbnail is the tallest child.
  compactThumbnailContainer: {
    width: COMPACT_THUMBNAIL_WIDTH,
    height: COMPACT_THUMBNAIL_HEIGHT,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  gradeText: {
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'right',
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
  consensusText: {
    fontWeight: '600',
  },
});
