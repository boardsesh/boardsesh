'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import ClimbIcons from './climb-icons';
import MarqueeText from './marquee-text';
import { themeTokens } from '@/app/theme/theme-config';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { formatSends, formatQuality } from '@/app/lib/format-climb-stats';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useEffectiveClimbStats } from '@/app/hooks/use-climb-stats-live';
import { useSubscribeClimbStatsUpdates } from '@/app/hooks/use-subscribe-climb-stats-updates';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';

const SUPPORTED_BOARD_SET = new Set<string>(SUPPORTED_BOARDS);

function asBoardName(s: string | undefined | null): BoardName | undefined {
  return s != null && SUPPORTED_BOARD_SET.has(s) ? (s as BoardName) : undefined;
}

export type ClimbTitleData = {
  name?: string;
  difficulty?: string | null;
  quality_average?: string | null;
  benchmark_difficulty?: string | null;
  angle?: number | string;
  setter_username?: string;
  ascensionist_count?: number;
  is_draft?: boolean;
  communityGrade?: string | null;
  is_no_match?: boolean;
  /** Climb identity. When `uuid` + `boardType` + a numeric `angle` are all
   *  present, ClimbTitle subscribes to live stat updates for this climb
   *  and reflects optimistic / WS-pushed values. Legacy callers that don't
   *  pass these stay on the raw `ascensionist_count` / `quality_average`. */
  uuid?: string;
  boardType?: string;
};

export type ClimbTitleProps = {
  climb?: ClimbTitleData | null;
  /** Show angle after difficulty/quality */
  showAngle?: boolean;
  /** Show setter and ascent count */
  showSetterInfo?: boolean;
  /** Custom element to render after the name (e.g., AscentStatus) */
  nameAddon?: React.ReactNode;
  /** Custom element to render on the far right (e.g., AscentStatus in play view) */
  rightAddon?: React.ReactNode;
  /** Use ellipsis for text overflow */
  ellipsis?: boolean;
  /** Additional className for the container */
  className?: string;
  /** Layout mode: 'stacked' (default) puts grade below name, 'horizontal' puts grade beside name */
  layout?: 'stacked' | 'horizontal';
  /** Center the content (useful for QueueControlBar) */
  centered?: boolean;
  /** Font size for the climb name. Use a design token, e.g. themeTokens.typography.fontSize.lg */
  titleFontSize?: number;
  /** Grade position: 'inline' (default) keeps grade in subtitle, 'right' floats colorized grade to the far right.
   *  When 'right', renders name + stars/setter on left and large colorized V-grade on right. Overrides layout prop. */
  gradePosition?: 'inline' | 'right';
  /** When true, shows a heart indicator in the byline */
  favorited?: boolean;
  /** When true, shows a "no matching" icon next to the climb name */
  isNoMatch?: boolean;
  /** When provided, replaces the computed subtitle in `gradePosition='right'` mode.
   *  Used by logbook items to show ascent-specific info (time ago, status, etc.). */
  subtitleOverride?: React.ReactNode;
  /** When true, the climb name marquees if it overflows. Used for the "active" climb
   *  (selected list item, current queue climb, drawer/detail header). */
  isActive?: boolean;
};

// --- Static sx objects hoisted to module scope (no reactive deps) ---

const noClimbSx = {
  fontSize: themeTokens.typography.fontSize.sm,
  fontWeight: themeTokens.typography.fontWeight.bold,
} as const;

const textOverflowSx = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

const subtitleSx = {
  fontSize: themeTokens.typography.fontSize.xs,
  fontWeight: themeTokens.typography.fontWeight.normal,
} as const;

const subtitleEllipsisSx = {
  ...subtitleSx,
  ...textOverflowSx,
} as const;

const italicSx = { fontStyle: 'italic' } as const;

const rowSx = {
  display: 'flex',
  alignItems: 'center',
  gap: `${themeTokens.spacing[2]}px`,
} as const;

const rowMinWidthSx = {
  ...rowSx,
  minWidth: 0,
} as const;

// gradePosition === 'right' layout
const rightContainerSx = {
  display: 'flex',
  alignItems: 'center',
  gap: `${themeTokens.spacing[2]}px`,
  width: '100%',
} as const;

const rightLeftColumnSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  flex: 1,
  minWidth: 0,
} as const;

const rightRightColumnSx = {
  display: 'flex',
  alignItems: 'center',
  gap: `${themeTokens.spacing[2]}px`,
  flexShrink: 0,
} as const;

// layout === 'horizontal'
const horizontalDefaultSx = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
} as const;

const horizontalCenteredSx = {
  display: 'flex',
  alignItems: 'center',
  position: 'relative',
  justifyContent: 'center',
} as const;

const horizontalCenterColumnDefaultSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  minWidth: 0,
  alignItems: 'flex-start',
  flex: 1,
} as const;

const horizontalCenterColumnCenteredSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  minWidth: 0,
  alignItems: 'center',
} as const;

const absoluteLeftSx = { position: 'absolute', left: 0 } as const;
const absoluteRightSx = { position: 'absolute', right: 0 } as const;

// default stacked layout
const stackedDefaultSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  alignItems: 'flex-start',
} as const;

const stackedCenteredSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  alignItems: 'center',
} as const;

/**
 * Reusable component for displaying climb title and info consistently across the app.
 * Used in ClimbCard, QueueControlBar, QueueListItem, and suggested items.
 */
const ClimbTitle: React.FC<ClimbTitleProps> = React.memo(
  ({
    climb,
    showAngle = false,
    showSetterInfo = false,
    nameAddon,
    rightAddon,
    ellipsis = true,
    className,
    layout = 'stacked',
    centered = false,
    titleFontSize,
    gradePosition = 'inline',
    favorited = false,
    isNoMatch = false,
    subtitleOverride,
    isActive = false,
  }) => {
    const { t } = useTranslation('climbs');
    const isDark = useIsDarkMode();
    const { formatGrade, getGradeColor, loaded: gradeFormatLoaded } = useGradeFormat();

    const resolvedSubtitleSx = ellipsis ? subtitleEllipsisSx : subtitleSx;

    // Derived values — safe to compute even when climb is null (used after the guard below)
    const displayDifficulty = climb?.communityGrade || climb?.difficulty;
    const formattedGrade = formatGrade(displayDifficulty);
    const nameFontSize = titleFontSize ?? themeTokens.typography.fontSize.sm;
    const gradeColor = formattedGrade ? getGradeColor(displayDifficulty, isDark) : undefined;

    // ALL useMemo hooks must be called unconditionally (before any early return)
    const nameSx = useMemo(
      () => ({
        fontSize: nameFontSize,
        fontWeight: themeTokens.typography.fontWeight.bold,
        ...(ellipsis ? textOverflowSx : {}),
      }),
      [nameFontSize, ellipsis],
    );

    const largeGradeSx = useMemo(
      () => ({
        fontSize: nameFontSize,
        fontWeight: themeTokens.typography.fontWeight.bold,
        lineHeight: 1,
        color: gradeColor ?? 'text.secondary',
      }),
      [nameFontSize, gradeColor],
    );

    const setterSx = useMemo(
      () => ({
        ...resolvedSubtitleSx,
        fontStyle: climb?.is_draft ? ('italic' as const) : undefined,
      }),
      [resolvedSubtitleSx, climb?.is_draft],
    );

    const fallbackGradeSx = useMemo(
      () => ({
        fontSize: nameFontSize,
        fontWeight: themeTokens.typography.fontWeight.semibold,
        lineHeight: 1,
      }),
      [nameFontSize],
    );

    // Live-stats hooks must run unconditionally. When `uuid`/`boardType`/
    // numeric `angle` aren't all present (older callers, project rows),
    // both hooks short-circuit and the displayed values fall back to the
    // raw props.
    const numericAngle = typeof climb?.angle === 'string' ? Number(climb.angle) : climb?.angle;
    const subscriptionAngle =
      typeof numericAngle === 'number' && Number.isFinite(numericAngle) ? numericAngle : undefined;
    const subscriptionBoard = asBoardName(climb?.boardType);
    useSubscribeClimbStatsUpdates(subscriptionBoard, climb?.uuid, subscriptionAngle);
    const effectiveStats = useEffectiveClimbStats(subscriptionBoard, climb?.uuid, subscriptionAngle, {
      ascensionist_count: climb?.ascensionist_count,
      quality_average: climb?.quality_average,
    });

    if (!climb) {
      return (
        <Typography variant="body2" component="span" sx={noClimbSx}>
          {t('card.title.noClimbSelected')}
        </Typography>
      );
    }

    const displayQualityAverage = effectiveStats.qualityAverage;
    const displayAscensionistCount = effectiveStats.ascensionistCount;
    const hasGrade = displayDifficulty && displayQualityAverage && displayQualityAverage !== '0';
    const resolvedIsNoMatch = isNoMatch || Boolean(climb.is_no_match);

    const renderDifficultyText = () => {
      if (hasGrade) {
        const baseText = `${displayDifficulty} ${formatQuality(displayQualityAverage!)}★`;
        return showAngle ? `${baseText} @ ${climb.angle}°` : baseText;
      }
      const projectText = showAngle ? t('card.title.projectAtAngle', { angle: climb.angle }) : t('card.title.project');
      return (
        <Box component="span" sx={italicSx}>
          {projectText}
        </Box>
      );
    };

    const nameElement = (
      <MarqueeText active={isActive}>
        <Typography variant="body2" component="span" sx={nameSx}>
          {climb.name}
          <ClimbIcons benchmarkDifficulty={climb.benchmark_difficulty} isNoMatch={resolvedIsNoMatch} />
        </Typography>
      </MarqueeText>
    );

    const gradeElement = (
      <Typography variant="body2" component="span" color="text.secondary" sx={resolvedSubtitleSx}>
        {renderDifficultyText()}
      </Typography>
    );

    let largeGradeContent: React.ReactNode = null;
    if (!gradeFormatLoaded) {
      largeGradeContent = (
        <Skeleton variant="rounded" width={nameFontSize * 2.2} height={nameFontSize} sx={{ flexShrink: 0 }} />
      );
    } else if (formattedGrade) {
      largeGradeContent = (
        <Typography variant="body2" component="span" sx={largeGradeSx}>
          {formattedGrade}
        </Typography>
      );
    }
    const largeGradeElement = displayDifficulty && largeGradeContent;

    const setterText = climb.is_draft
      ? `Draft by ${climb.setter_username}`
      : `By ${climb.setter_username}${displayAscensionistCount ? ` - ${formatSends(displayAscensionistCount)}` : ''}`;

    const setterElement = showSetterInfo && climb.setter_username && (
      <Typography variant="body2" component="span" color="text.secondary" sx={setterSx}>
        {setterText}
      </Typography>
    );

    if (gradePosition === 'right') {
      const subtitleParts: string[] = [];
      if (climb.is_draft) {
        subtitleParts.push('Draft');
      }
      if (!climb.is_draft && displayAscensionistCount) {
        subtitleParts.push(formatSends(displayAscensionistCount));
      }
      if (hasGrade) {
        subtitleParts.push(`${formatQuality(displayQualityAverage!)}\u2605`);
      }
      if (showSetterInfo && climb.setter_username) {
        subtitleParts.push(climb.setter_username);
      }

      if (favorited) {
        subtitleParts.push('\u2665');
      }

      const subtitleContent =
        subtitleOverride ??
        (subtitleParts.length > 0 ? (
          subtitleParts.join(' \u00b7 ')
        ) : (
          <Box component="span" sx={italicSx}>
            {t('card.title.project')}
          </Box>
        ));

      return (
        <Box sx={rightContainerSx} className={className}>
          {/* Left: Name + subtitle */}
          <Box sx={rightLeftColumnSx}>
            {/* Row 1: Name with addon */}
            <Box sx={rowMinWidthSx}>
              {nameElement}
              {nameAddon}
            </Box>
            {/* Row 2: Stars + setter */}
            <Typography variant="body2" component="span" color="text.secondary" sx={resolvedSubtitleSx}>
              {subtitleContent}
            </Typography>
          </Box>
          {/* Right: rightAddon + colorized grade */}
          <Box sx={rightRightColumnSx}>
            {rightAddon}
            {largeGradeElement}
            {!formattedGrade && displayDifficulty && (
              <Typography variant="body2" component="span" color="text.secondary" sx={fallbackGradeSx}>
                {displayDifficulty}
              </Typography>
            )}
          </Box>
        </Box>
      );
    }

    if (layout === 'horizontal') {
      const secondLineContent = [];
      if (climb.is_draft) {
        secondLineContent.push('Draft');
      }
      if (hasGrade) {
        secondLineContent.push(`${displayDifficulty} ${formatQuality(displayQualityAverage!)}★`);
      }
      if (showSetterInfo && climb.setter_username) {
        secondLineContent.push(`${climb.setter_username}`);
      }
      if (!climb.is_draft && displayAscensionistCount) {
        secondLineContent.push(formatSends(displayAscensionistCount));
      }

      return (
        <Box sx={centered ? horizontalCenteredSx : horizontalDefaultSx} className={className}>
          {/* Colorized grade - absolutely positioned left when centered */}
          {largeGradeElement && <Box sx={centered ? absoluteLeftSx : undefined}>{largeGradeElement}</Box>}
          {/* Center: Name and quality/setter stacked */}
          <Box sx={centered ? horizontalCenterColumnCenteredSx : horizontalCenterColumnDefaultSx}>
            {/* Row 1: Name with addon */}
            <Box sx={rowSx}>
              {nameElement}
              {nameAddon}
            </Box>
            {/* Row 2: Quality, setter, ascents */}
            <Typography variant="body2" component="span" color="text.secondary" sx={resolvedSubtitleSx}>
              {secondLineContent.length > 0 ? (
                secondLineContent.join(' · ')
              ) : (
                <Box component="span" sx={italicSx}>
                  {t('card.title.project')}
                </Box>
              )}
            </Typography>
          </Box>
          {/* Right addon - absolutely positioned right when centered */}
          {rightAddon && <Box sx={centered ? absoluteRightSx : undefined}>{rightAddon}</Box>}
        </Box>
      );
    }

    return (
      <Box sx={centered ? stackedCenteredSx : stackedDefaultSx} className={className}>
        {/* Row 1: Name with optional benchmark icon and addon (e.g., AscentStatus) */}
        <Box sx={rowSx}>
          {nameElement}
          {nameAddon}
        </Box>
        {/* Row 2: Difficulty/Quality and optional Angle */}
        {gradeElement}
        {/* Row 3 (optional): Setter info */}
        {setterElement}
      </Box>
    );
  },
  (prev, next) => {
    // Fast path: same climb reference
    if (prev.climb === next.climb) {
      return (
        prev.showAngle === next.showAngle &&
        prev.showSetterInfo === next.showSetterInfo &&
        prev.nameAddon === next.nameAddon &&
        prev.rightAddon === next.rightAddon &&
        prev.ellipsis === next.ellipsis &&
        prev.className === next.className &&
        prev.layout === next.layout &&
        prev.centered === next.centered &&
        prev.titleFontSize === next.titleFontSize &&
        prev.gradePosition === next.gradePosition &&
        prev.favorited === next.favorited &&
        prev.isNoMatch === next.isNoMatch &&
        prev.subtitleOverride === next.subtitleOverride &&
        prev.isActive === next.isActive
      );
    }

    // Different climb reference — compare display-relevant fields
    const prevClimb = prev.climb;
    const nextClimb = next.climb;

    if (prevClimb == null || nextClimb == null) return prevClimb === nextClimb;

    return (
      prevClimb.name === nextClimb.name &&
      prevClimb.difficulty === nextClimb.difficulty &&
      prevClimb.quality_average === nextClimb.quality_average &&
      prevClimb.benchmark_difficulty === nextClimb.benchmark_difficulty &&
      prevClimb.angle === nextClimb.angle &&
      prevClimb.setter_username === nextClimb.setter_username &&
      prevClimb.ascensionist_count === nextClimb.ascensionist_count &&
      prevClimb.is_draft === nextClimb.is_draft &&
      prevClimb.communityGrade === nextClimb.communityGrade &&
      prevClimb.is_no_match === nextClimb.is_no_match &&
      prevClimb.uuid === nextClimb.uuid &&
      prevClimb.boardType === nextClimb.boardType &&
      prev.showAngle === next.showAngle &&
      prev.showSetterInfo === next.showSetterInfo &&
      prev.nameAddon === next.nameAddon &&
      prev.rightAddon === next.rightAddon &&
      prev.ellipsis === next.ellipsis &&
      prev.className === next.className &&
      prev.layout === next.layout &&
      prev.centered === next.centered &&
      prev.titleFontSize === next.titleFontSize &&
      prev.gradePosition === next.gradePosition &&
      prev.favorited === next.favorited &&
      prev.isNoMatch === next.isNoMatch &&
      prev.subtitleOverride === next.subtitleOverride &&
      prev.isActive === next.isActive
    );
  },
);

ClimbTitle.displayName = 'ClimbTitle';

export default ClimbTitle;
