import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { useDisplayGrade } from '../hooks/use-display-grade';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
import { ClimbPlaylistChips } from './ClimbPlaylistChips';
import { isClimbResolved } from '../lib/queue-climb-resolution';
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
};

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
}: ClimbListItemContentProps) {
  const { t } = useTranslation('climbs');
  const { t: tSession } = useTranslation('session');
  const { resolveGrade } = useDisplayGrade();
  const { systemColors } = useTheme();

  // Subtitle parts: sends · quality★ · setter (each dropped when absent). A
  // caller-supplied override wins outright — a string replaces the line, null
  // hides it — so session rows can show the sender instead. Tolerates a nullish
  // climb (partially-synced peer item) — the placeholder branch below renders
  // before this value is read in that case.
  const subtitleText = useMemo(() => {
    if (primarySubtitleOverride !== undefined) return primarySubtitleOverride;
    if (!climb) return null;
    const parts: string[] = [];
    if (climb.is_draft) {
      parts.push(t('createClimbForm.draftBadge'));
    }
    if (!climb.is_draft && climb.ascensionist_count) {
      parts.push(formatSends(climb.ascensionist_count, t));
    }
    const qualityNum = parseFloat(climb.quality_average);
    if (qualityNum > 0) {
      parts.push(`${formatQuality(climb.quality_average)}★`);
    }
    if (climb.setter_username) {
      parts.push(climb.setter_username);
    }
    return parts.length > 0 ? parts.join(' · ') : t('mobile.climbRow.projectFallback');
  }, [
    primarySubtitleOverride,
    climb?.is_draft,
    climb?.ascensionist_count,
    climb?.quality_average,
    climb?.setter_username,
    t,
  ]);

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

  // One O(1) resolve per row: the Boardsesh grade (label + colour) when the "Show
  // Boardsesh grades" toggle is on and a trusted one exists, else the legacy
  // Aurora grade. `resolveGrade` is the stable callback from `useDisplayGrade`
  // (called once above), so it never re-derives per render beyond this call.
  const { label: formattedGrade, color: gradeColor } = resolveGrade(climb);

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
        {subtitleText ? (
          <Text variant="footnote" numberOfLines={1} style={styles.subtitle}>
            {subtitleText}
          </Text>
        ) : null}
        {subtitleDetailText ? (
          <Text variant="caption1" numberOfLines={1} style={styles.subtitle}>
            {subtitleDetailText}
          </Text>
        ) : null}
        {showPlaylistChips ? <ClimbPlaylistChips climbUuid={climb.uuid} /> : null}
      </View>

      {/* Right: ascent-status glyph + colorized grade — the two scan keys together */}
      <View style={styles.rightSection}>
        {showAscentStatus ? <AscentStatusGlyph climbUuid={climb.uuid} angle={angle} /> : null}
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
