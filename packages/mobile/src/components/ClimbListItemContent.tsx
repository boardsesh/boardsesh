import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { useDisplayGrade } from '../hooks/use-display-grade';
import { useGradeFormat } from '../hooks/use-grade-format';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useMyGrade } from '../hooks/use-my-grade';
import { renderDifficulty } from '../lib/boardsesh-grade-display';
import { deriveGradeTokenModel, gradeTokenA11yLabel, type GradeTokenModel } from '@boardsesh/logbook';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { GradeValue, type GradeSource } from './grade/GradeValue';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
import { ClimbPlaylistChips } from './ClimbPlaylistChips';
import { isClimbResolved } from '../lib/queue-climb-resolution';
import { useIsClimbFavorited } from '../hooks/use-is-climb-favorited';
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
 * Isolated, memoized ascent-status glyph, subscribed to the logbook via
 * `useAscentStatus` → `BoardProvider`, so a tick write / logbook merge
 * re-renders just this 16px icon. Props are primitives, so `React.memo` skips
 * it on unrelated parent re-renders. Restores the memo boundary the
 * climbs-search redesign removed when it inlined `useAscentStatus` into
 * `ClimbListItemContent`.
 *
 * This, `LiveClimbGrade` and `LiveClimbSubtitle` are the row's logbook
 * subscribers, and each is its own memo boundary. All three have to be — your
 * own grade wins over the crowd's, so the number must move when a tick lands,
 * and the crowd's number now rides the subtitle run whenever it is not the one
 * in the column. Keep the subscription inside these children. Hoisting any of
 * them into `ClimbListItemContent` re-renders the thumbnail and name on every
 * merge, which is the regression this boundary exists to prevent. They read a
 * dedicated, memoized logbook context that changes only when ticks merge —
 * never per frame — so the third consumer costs a visible row one extra Text
 * render on a tick save.
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

/**
 * The row's grade model: which number the column shows, whether that number
 * needs a `person` marker, and what the subtitle should lead with.
 *
 * Read by BOTH the subtitle and the grade column. They stay separate memo
 * boundaries (see `AscentStatusGlyph`) and the crowd's number now lives on the
 * subtitle line, so the two have to reach the same answer from the same
 * inputs. It costs a couple of Map lookups over the pre-built logbook index —
 * no scan, no per-row state, no work proportional to the logbook.
 */
function useClimbGradeToken(climb: ClimbListItemClimb, boardName: BoardName, layoutId: number, angle: number) {
  const { resolveGrade } = useDisplayGrade();
  const { gradeFormat } = useGradeFormat();
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climb.uuid, angle, {
    ascensionistCount: climb.ascensionist_count ?? 0,
    qualityAverage: climb.quality_average,
    difficulty: climb.difficulty,
  });
  // The canonical community difficulty may change, but the Boardsesh grade
  // fields remain authoritative when that preference is active.
  const { label: crowdLabel, color: crowdColor } = resolveGrade({
    ...climb,
    difficulty: liveStats.difficulty,
  });

  // Your grade wins over the crowd's (#4796, #4828). Resolved ABOVE
  // `resolveGrade` rather than inside it: that resolver's contract is
  // community-grade-only (its `boardseshDifficulty`/`boardseshConfidence`
  // fields must only ever accompany a community grade), and its own docblock
  // says a caller holding a user grade has to check it first.
  const myGrade = useMyGrade(climb.uuid, angle);
  const mine = myGrade.status === 'set' ? renderDifficulty(myGrade.difficultyId, gradeFormat) : null;

  // The climbs list is a catalog of the board's climbs, so the crowd's number
  // is the unremarkable one here and yours is what gets marked.
  const model: GradeTokenModel = deriveGradeTokenModel({
    personalLabel: mine?.label ?? null,
    crowdLabel,
    baseline: 'crowd',
  });

  return { model, color: model.source === 'personal' && mine ? mine.color : crowdColor, liveStats };
}

const LiveClimbSubtitle = React.memo(function LiveClimbSubtitle({
  climb,
  boardName,
  layoutId,
  angle,
}: {
  climb: ClimbListItemClimb;
  boardName: BoardName;
  layoutId: number;
  angle: number;
}) {
  const { t } = useTranslation('climbs');
  const { model, liveStats } = useClimbGradeToken(climb, boardName, layoutId, angle);

  const parts: string[] = [];
  // The crowd's number leads the run whenever it is NOT the number in the
  // grade column — grey, uncoloured, one token among the other facts about the
  // climb. This is where the demoted second grade went: it costs the row no
  // height, so the column stays one line in every state.
  if (model.crowdLineToken) parts.push(model.crowdLineToken);
  const isDraft = climb.is_draft ?? false;
  if (isDraft) parts.push(t('createClimbForm.draftBadge'));
  if (!isDraft && liveStats.ascensionistCount > 0) {
    parts.push(formatSends(liveStats.ascensionistCount, t));
  }
  const liveQuality = liveStats.qualityAverage;
  if (liveQuality != null && parseFloat(liveQuality) > 0) parts.push(`${formatQuality(liveQuality)}★`);
  if (climb.setter_username) parts.push(climb.setter_username);
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
}: {
  climb: ClimbListItemClimb;
  boardName: BoardName;
  layoutId: number;
  angle: number;
}) {
  const { t } = useTranslation('climbs');
  const { model, color } = useClimbGradeToken(climb, boardName, layoutId, angle);

  // `gradeTokenA11yLabel` resolves its keys out of @boardsesh/logbook, which the
  // i18n orphan checker does not scan — so name them here:
  // i18n-keep common.mobile.gradeToken.a11yYours
  // i18n-keep common.mobile.gradeToken.a11yCommunity
  const accessibilityLabel = gradeTokenA11yLabel(model, t) ?? undefined;

  // A climb with no grade anywhere still holds the column open so the row's
  // right edge does not move down the list. There is no number to attribute,
  // so it reads as the crowd's and never marks.
  const source: GradeSource = model.source === 'none' ? 'crowd' : model.source;

  return (
    <GradeValue
      label={model.label}
      color={color}
      source={source}
      baseline="crowd"
      accessibilityLabel={accessibilityLabel}
    />
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
  showPlaylistChips = false,
  showFavorite = false,
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
          <LiveClimbSubtitle climb={climb} boardName={boardName} layoutId={layoutId} angle={angle} />
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

      {/* Right: favourite heart + ascent-status glyph + the one grade slot */}
      <View style={styles.rightSection}>
        {showFavorite ? <FavoriteGlyph climbUuid={climb.uuid} /> : null}
        {showAscentStatus ? <AscentStatusGlyph climbUuid={climb.uuid} angle={angle} /> : null}
        <LiveClimbGrade climb={climb} boardName={boardName} layoutId={layoutId} angle={angle} />
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
});
