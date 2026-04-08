'use client';

import React, { useMemo } from 'react';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import ClimbIcons from './climb-icons';
import { themeTokens } from '@/app/theme/theme-config';
import { getSoftVGradeColor, formatVGrade } from '@/app/lib/grade-colors';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { formatSends, formatQuality } from '@/app/lib/format-climb-stats';

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
const ClimbTitle: React.FC<ClimbTitleProps> = React.memo(({
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
}) => {
  const isDark = useIsDarkMode();

  const resolvedSubtitleSx = ellipsis ? subtitleEllipsisSx : subtitleSx;

  // Derived values — safe to compute even when climb is null (used after the guard below)
  const displayDifficulty = climb?.communityGrade || climb?.difficulty;
  const vGrade = formatVGrade(displayDifficulty);
  const nameFontSize = titleFontSize ?? themeTokens.typography.fontSize.sm;
  const gradeColor = vGrade ? getSoftVGradeColor(vGrade, isDark) : undefined;

  // ALL useMemo hooks must be called unconditionally (before any early return)
  const nameSx = useMemo(() => ({
    fontSize: nameFontSize,
    fontWeight: themeTokens.typography.fontWeight.bold,
    ...(ellipsis ? textOverflowSx : {}),
  }), [nameFontSize, ellipsis]);

  const largeGradeSx = useMemo(() => ({
    fontSize: nameFontSize,
    fontWeight: themeTokens.typography.fontWeight.bold,
    lineHeight: 1,
    color: gradeColor ?? 'text.secondary',
  }), [nameFontSize, gradeColor]);

  const setterSx = useMemo(() => ({
    ...resolvedSubtitleSx,
    fontStyle: climb?.is_draft ? ('italic' as const) : undefined,
  }), [resolvedSubtitleSx, climb?.is_draft]);

  const fallbackGradeSx = useMemo(() => ({
    fontSize: nameFontSize,
    fontWeight: themeTokens.typography.fontWeight.semibold,
    lineHeight: 1,
  }), [nameFontSize]);

  if (!climb) {
    return (
      <Typography variant="body2" component="span" sx={noClimbSx}>
        No climb selected
      </Typography>
    );
  }

  const hasGrade = displayDifficulty && climb.quality_average && climb.quality_average !== '0';
  const resolvedIsNoMatch = isNoMatch || Boolean(climb.is_no_match);

  const renderDifficultyText = () => {
    if (hasGrade) {
      const baseText = `${displayDifficulty} ${formatQuality(climb.quality_average!)}★`;
      return showAngle ? `${baseText} @ ${climb.angle}°` : baseText;
    }
    const projectText = showAngle ? `project @ ${climb.angle}°` : 'project';
    return <Box component="span" sx={italicSx}>{projectText}</Box>;
  };

  const nameElement = (
    <Typography variant="body2" component="span" sx={nameSx}>
      {climb.name}
      <ClimbIcons benchmarkDifficulty={climb.benchmark_difficulty} isNoMatch={resolvedIsNoMatch} />
    </Typography>
  );

  const gradeElement = (
    <Typography variant="body2" component="span" color="text.secondary" sx={resolvedSubtitleSx}>
      {renderDifficultyText()}
    </Typography>
  );

  const largeGradeElement = vGrade && (
    <Typography variant="body2" component="span" sx={largeGradeSx}>
      {vGrade}
    </Typography>
  );

  const setterText = climb.is_draft
    ? `Draft by ${climb.setter_username}`
    : `By ${climb.setter_username}${climb.ascensionist_count ? ` - ${formatSends(climb.ascensionist_count)}` : ''}`;

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
    if (!climb.is_draft && climb.ascensionist_count) {
      subtitleParts.push(formatSends(climb.ascensionist_count));
    }
    if (hasGrade) {
      subtitleParts.push(`${formatQuality(climb.quality_average!)}\u2605`);
    }
    if (showSetterInfo && climb.setter_username) {
      subtitleParts.push(climb.setter_username);
    }

    if (favorited) {
      subtitleParts.push('\u2665');
    }

    const subtitleContent = subtitleParts.length > 0
      ? subtitleParts.join(' \u00b7 ')
      : <Box component="span" sx={italicSx}>project</Box>;

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
          {!vGrade && displayDifficulty && (
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
      secondLineContent.push(`${displayDifficulty} ${formatQuality(climb.quality_average!)}★`);
    }
    if (showSetterInfo && climb.setter_username) {
      secondLineContent.push(`${climb.setter_username}`);
    }
    if (!climb.is_draft && climb.ascensionist_count) {
      secondLineContent.push(formatSends(climb.ascensionist_count));
    }

    return (
      <Box sx={centered ? horizontalCenteredSx : horizontalDefaultSx} className={className}>
        {/* Colorized V grade - absolutely positioned left when centered */}
        {largeGradeElement && (
          <Box sx={centered ? absoluteLeftSx : undefined}>
            {largeGradeElement}
          </Box>
        )}
        {/* Center: Name and quality/setter stacked */}
        <Box sx={centered ? horizontalCenterColumnCenteredSx : horizontalCenterColumnDefaultSx}>
          {/* Row 1: Name with addon */}
          <Box sx={rowSx}>
            {nameElement}
            {nameAddon}
          </Box>
          {/* Row 2: Quality, setter, ascents */}
          <Typography variant="body2" component="span" color="text.secondary" sx={resolvedSubtitleSx}>
            {secondLineContent.length > 0 ? secondLineContent.join(' · ') : <Box component="span" sx={italicSx}>project</Box>}
          </Typography>
        </Box>
        {/* Right addon - absolutely positioned right when centered */}
        {rightAddon && (
          <Box sx={centered ? absoluteRightSx : undefined}>
            {rightAddon}
          </Box>
        )}
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
}, (prev, next) => {
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
      prev.isNoMatch === next.isNoMatch
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
    prev.isNoMatch === next.isNoMatch
  );
});

ClimbTitle.displayName = 'ClimbTitle';

export default ClimbTitle;
