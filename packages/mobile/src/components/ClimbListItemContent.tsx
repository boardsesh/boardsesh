import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from './Text';
import { ClimbListThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from './ClimbListThumbnail';
import { formatSends, formatQuality } from '../lib/format-climb-stats';
import { useGradeFormat } from '../hooks/use-grade-format';
import { useAscentCountSource } from '../lib/ascent-count-source-preference';
import { selectSourceCount } from '../lib/ascent-count-source';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import { ClimbAttributeIcons } from './ClimbAttributeIcons';
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
  // Per-source ascensionist counts (all nullable). The subtitle's sends figure
  // honours the user's "Ascent counts" setting via `selectSourceCount`; absent
  // fields fall back to the total. Constructors that don't carry them (tick-to-
  // climb, presence) leave them undefined and the selector uses the total.
  kilterAscensionistCount?: number | null;
  auroraAscensionistCount?: number | null;
  boardseshAscensionistCount?: number | null;
  quality_average: string;
  setter_username?: string | null;
  // Intrinsic climb attributes shown as grey glyphs after the name.
  is_no_match?: boolean | null;
  benchmark_difficulty?: string | null;
  characteristics?: string[] | null;
};

type ClimbListItemContentProps = {
  climb: ClimbListItemClimb;
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
}: ClimbListItemContentProps) {
  const { t } = useTranslation('climbs');
  const { formatGrade } = useGradeFormat();
  const { systemColors } = useTheme();
  const { source: ascentCountSource } = useAscentCountSource();

  const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
  const formattedGrade = formatGrade(climb.difficulty);

  // Sends shown per the user's "Ascent counts" setting. A climb with no per-
  // source fields (queue/tick/presence shapes) falls back to the total.
  const sendsCount = useMemo(
    () =>
      selectSourceCount(
        {
          total: climb.ascensionist_count ?? 0,
          kilter: climb.kilterAscensionistCount,
          aurora: climb.auroraAscensionistCount,
          boardsesh: climb.boardseshAscensionistCount,
        },
        ascentCountSource,
      ),
    [
      climb.ascensionist_count,
      climb.kilterAscensionistCount,
      climb.auroraAscensionistCount,
      climb.boardseshAscensionistCount,
      ascentCountSource,
    ],
  );

  // Subtitle parts: sends · quality★ · setter (each dropped when absent). A
  // caller-supplied override wins outright — a string replaces the line, null
  // hides it — so session rows can show the sender instead.
  const subtitleText = useMemo(() => {
    if (primarySubtitleOverride !== undefined) return primarySubtitleOverride;
    const parts: string[] = [];
    if (climb.is_draft) {
      parts.push(t('createClimbForm.draftBadge'));
    }
    if (!climb.is_draft && sendsCount) {
      parts.push(formatSends(sendsCount, t));
    }
    const qualityNum = parseFloat(climb.quality_average);
    if (qualityNum > 0) {
      parts.push(`${formatQuality(climb.quality_average)}★`);
    }
    if (climb.setter_username) {
      parts.push(climb.setter_username);
    }
    return parts.length > 0 ? parts.join(' · ') : t('mobile.climbRow.projectFallback');
  }, [primarySubtitleOverride, climb.is_draft, sendsCount, climb.quality_average, climb.setter_username, t]);

  const subtitleDetailText = useMemo(() => {
    const parts = subtitleDetailParts?.filter((part) => part.length > 0) ?? [];
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [subtitleDetailParts]);

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
      </View>

      {/* Right: ascent-status glyph + colorized grade — the two scan keys together */}
      <View style={styles.rightSection}>
        {showAscentStatus ? <AscentStatusGlyph climbUuid={climb.uuid} angle={angle} /> : null}
        <View style={styles.gradeColumn}>
          <View style={styles.iconGradeRow}>
            {gradeIsConsensus ? <Icon name="people" size={13} color={systemColors.secondaryLabel} /> : null}
            <Text variant="title3" numberOfLines={1} style={[styles.gradeText, { color: gradeColor }]}>
              {formattedGrade ?? climb.difficulty}
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
