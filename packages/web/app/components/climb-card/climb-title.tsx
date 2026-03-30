'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import CopyrightOutlined from '@mui/icons-material/CopyrightOutlined';
import { themeTokens } from '@/app/theme/theme-config';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { useGradeFormat } from '@/app/hooks/use-grade-format';

export type ClimbTitleData = {
  name?: string;
  difficulty?: string | null;
  quality_average?: string | null;
  benchmark_difficulty?: string | null;
  angle?: number | string;
  setter_username?: string;
  ascensionist_count?: number;
  communityGrade?: string | null;
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
};

/**
 * Reusable component for displaying climb title and info consistently across the app.
 * Used in ClimbCard, QueueControlBar, QueueListItem, and suggested items.
 */
const ClimbTitle: React.FC<ClimbTitleProps> = ({
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
}) => {
  const isDark = useIsDarkMode();
  const { formatGrade, getGradeColor } = useGradeFormat();

  if (!climb) {
    return (
      <Typography
        variant="body2"
        component="span"
        sx={{
          fontSize: themeTokens.typography.fontSize.sm,
          fontWeight: themeTokens.typography.fontWeight.bold,
        }}
      >
        No climb selected
      </Typography>
    );
  }

  // Use community grade when available, otherwise fall back to original difficulty
  const displayDifficulty = climb.communityGrade || climb.difficulty;

  const hasGrade = displayDifficulty && climb.quality_average && climb.quality_average !== '0';
  // A climb is a benchmark/classic if benchmark_difficulty is a positive number.
  // Handle both string and numeric types defensively since the value may arrive
  // as a raw number from some code paths or as a string from GraphQL.
  const benchmarkValue = climb.benchmark_difficulty != null ? Number(climb.benchmark_difficulty) : null;
  const isBenchmark = benchmarkValue !== null && benchmarkValue > 0 && !Number.isNaN(benchmarkValue);

  const formattedGrade = formatGrade(displayDifficulty);

  const textOverflowStyles = ellipsis
    ? {
        whiteSpace: 'nowrap' as const,
        overflow: 'hidden' as const,
        textOverflow: 'ellipsis' as const,
      }
    : {};

  const renderDifficultyText = () => {
    if (hasGrade) {
      const baseText = `${displayDifficulty} ${climb.quality_average}★`;
      return showAngle ? `${baseText} @ ${climb.angle}°` : baseText;
    }
    const projectText = showAngle ? `project @ ${climb.angle}°` : 'project';
    return <Box component="span" sx={{ fontStyle: 'italic' }}>{projectText}</Box>;
  };

  const nameFontSize = titleFontSize ?? themeTokens.typography.fontSize.sm;

  const nameElement = (
    <Typography
      variant="body2"
      component="span"
      sx={{
        fontSize: nameFontSize,
        fontWeight: themeTokens.typography.fontWeight.bold,
        ...textOverflowStyles,
      }}
    >
      {climb.name}
      {isBenchmark && (
        <CopyrightOutlined
          sx={{
            marginLeft: '4px',
            fontSize: themeTokens.typography.fontSize.xs,
            color: themeTokens.colors.primary,
          }}
        />
      )}
    </Typography>
  );

  const gradeElement = (
    <Typography
      variant="body2"
      component="span"
      color="text.secondary"
      sx={{
        fontSize: themeTokens.typography.fontSize.xs,
        fontWeight: themeTokens.typography.fontWeight.normal,
        ...textOverflowStyles,
      }}
    >
      {renderDifficultyText()}
    </Typography>
  );

  const gradeColor = formattedGrade ? getGradeColor(displayDifficulty, isDark) : undefined;

  const largeGradeElement = formattedGrade && (
    <Typography
      variant="body2"
      component="span"
      sx={{
        fontSize: nameFontSize,
        fontWeight: themeTokens.typography.fontWeight.bold,
        lineHeight: 1,
        color: gradeColor ?? 'text.secondary',
      }}
    >
      {formattedGrade}
    </Typography>
  );

  const setterElement = showSetterInfo && climb.setter_username && (
    <Typography
      variant="body2"
      component="span"
      color="text.secondary"
      sx={{
        fontSize: themeTokens.typography.fontSize.xs,
        fontWeight: themeTokens.typography.fontWeight.normal,
        ...textOverflowStyles,
      }}
    >
      By {climb.setter_username} - {climb.ascensionist_count ?? 0} ascents
    </Typography>
  );

  if (gradePosition === 'right') {
    const subtitleParts: string[] = [];
    if (hasGrade) {
      subtitleParts.push(`${climb.quality_average}\u2605`);
    }
    if (showSetterInfo && climb.setter_username) {
      subtitleParts.push(climb.setter_username);
    }

    const subtitleContent = subtitleParts.length > 0
      ? subtitleParts.join(' \u00b7 ')
      : <Box component="span" sx={{ fontStyle: 'italic' }}>project</Box>;

    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: `${themeTokens.spacing[2]}px`, width: '100%' }} className={className}>
        {/* Left: Name + subtitle */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
          {/* Row 1: Name with addon */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: `${themeTokens.spacing[2]}px`, minWidth: 0 }}>
            {nameElement}
            {nameAddon}
          </Box>
          {/* Row 2: Stars + setter */}
          <Typography
            variant="body2"
            component="span"
            color="text.secondary"
            sx={{
              fontSize: themeTokens.typography.fontSize.xs,
              fontWeight: themeTokens.typography.fontWeight.normal,
              ...textOverflowStyles,
            }}
          >
            {subtitleContent}
          </Typography>
        </Box>
        {/* Right: rightAddon + colorized grade */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: `${themeTokens.spacing[2]}px`, flexShrink: 0 }}>
          {rightAddon}
          {largeGradeElement}
          {!formattedGrade && displayDifficulty && (
            <Typography
              variant="body2"
              component="span"
              color="text.secondary"
              sx={{
                fontSize: nameFontSize,
                fontWeight: themeTokens.typography.fontWeight.semibold,
                lineHeight: 1,
              }}
            >
              {displayDifficulty}
            </Typography>
          )}
        </Box>
      </Box>
    );
  }

  if (layout === 'horizontal') {
    const secondLineContent = [];
    if (hasGrade) {
      secondLineContent.push(`${displayDifficulty} ${climb.quality_average}★`);
    }
    if (showSetterInfo && climb.setter_username) {
      secondLineContent.push(`${climb.setter_username}`);
    }
    if (climb.ascensionist_count !== undefined) {
      secondLineContent.push(`${climb.ascensionist_count} ascents`);
    }

    return (
      <Box sx={{ display: 'flex', alignItems: 'center', ...(centered ? { position: 'relative', justifyContent: 'center' } : { gap: '12px' }) }} className={className}>
        {/* Colorized V grade - absolutely positioned left when centered */}
        {largeGradeElement && (
          <Box sx={centered ? { position: 'absolute', left: 0 } : undefined}>
            {largeGradeElement}
          </Box>
        )}
        {/* Center: Name and quality/setter stacked */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0, alignItems: centered ? 'center' : 'flex-start', ...(centered ? {} : { flex: 1 }) }}>
          {/* Row 1: Name with addon */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: `${themeTokens.spacing[2]}px` }}>
            {nameElement}
            {nameAddon}
          </Box>
          {/* Row 2: Quality, setter, ascents */}
          <Typography
            variant="body2"
            component="span"
            color="text.secondary"
            sx={{
              fontSize: themeTokens.typography.fontSize.xs,
              fontWeight: themeTokens.typography.fontWeight.normal,
              ...textOverflowStyles,
            }}
          >
            {secondLineContent.length > 0 ? secondLineContent.join(' · ') : <Box component="span" sx={{ fontStyle: 'italic' }}>project</Box>}
          </Typography>
        </Box>
        {/* Right addon - absolutely positioned right when centered */}
        {rightAddon && (
          <Box sx={centered ? { position: 'absolute', right: 0 } : undefined}>
            {rightAddon}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: centered ? 'center' : 'flex-start' }} className={className}>
      {/* Row 1: Name with optional benchmark icon and addon (e.g., AscentStatus) */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: `${themeTokens.spacing[2]}px` }}>
        {nameElement}
        {nameAddon}
      </Box>
      {/* Row 2: Difficulty/Quality and optional Angle */}
      {gradeElement}
      {/* Row 3 (optional): Setter info */}
      {setterElement}
    </Box>
  );
};

export default ClimbTitle;
