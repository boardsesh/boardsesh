import { getGradeColor } from '@/app/lib/grade-colors';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import {
  BOARD_TYPES,
  difficultyMapping,
  getDifficultyMapping,
  sortGrades,
  getLayoutKey,
  getLayoutDisplayName,
  type LogbookEntry,
  type UnifiedTimeframeType,
} from '@boardsesh/profile-stats';

// The climbing-stats aggregation + grade/layout helpers now live in the
// renderer-agnostic @boardsesh/profile-stats package so mobile can reuse them.
// This file keeps the WEB-only presentation concerns (layout/grade chart
// colors, MUI-facing option lists, the REST UserProfile shape) and re-exports
// the shared pure helpers for back-compat with existing web call sites.

export { BOARD_TYPES, difficultyMapping, getDifficultyMapping, sortGrades, getLayoutKey, getLayoutDisplayName };
export type { LogbookEntry, UnifiedTimeframeType };

export type UserProfile = {
  id: string;
  email: string | undefined;
  name: string | null;
  image: string | null;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
    instagramUrl: string | null;
  } | null;
  credentials?: Array<{
    boardType: string;
    auroraUsername: string;
  }>;
  followerCount: number;
  followingCount: number;
  isFollowedByMe: boolean;
};

// Colors for each layout — soft, muted palette that feels cohesive.
const layoutColors: Record<string, string> = {
  'kilter-1': 'hsla(190, 55%, 52%, 0.7)', // Muted teal
  'kilter-8': 'hsla(160, 40%, 50%, 0.7)', // Soft sage green
  'tension-9': 'hsla(350, 50%, 58%, 0.7)', // Dusty rose
  'tension-10': 'hsla(20, 55%, 58%, 0.7)', // Warm terracotta
  'tension-11': 'hsla(42, 50%, 55%, 0.7)', // Muted gold
  'moonboard-1': 'hsla(270, 40%, 58%, 0.7)', // Soft lavender
  'moonboard-2': 'hsla(250, 40%, 55%, 0.7)', // Muted indigo
  'moonboard-3': 'hsla(290, 35%, 55%, 0.7)', // Soft plum
  'moonboard-4': 'hsla(230, 40%, 58%, 0.7)', // Dusty blue
  'moonboard-5': 'hsla(210, 45%, 55%, 0.7)', // Slate blue
  'decoy-2': 'hsla(100, 40%, 52%, 0.7)', // Soft green
  'touchstone-1': 'hsla(30, 50%, 55%, 0.7)', // Warm amber
  'grasshopper-1': 'hsla(75, 45%, 50%, 0.7)', // Yellow-green
};

export const getLayoutColor = (boardType: string, layoutId: number | null | undefined): string => {
  const key = getLayoutKey(boardType, layoutId);
  return layoutColors[key] || (boardType === 'kilter' ? 'rgba(6, 182, 212, 0.5)' : 'rgba(239, 68, 68, 0.5)');
};

/**
 * Softened grade color for chart bars — preserves hue but lowers saturation
 * and raises lightness for a cohesive, muted look.
 */
export const getGradeChartColor = (grade: string): string => {
  const hexColor = getGradeColor(grade);
  if (!hexColor) return 'hsla(0, 0%, 78%, 0.7)';

  // Convert hex to HSL for smoother control
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  // Muted: cap saturation at 50%, raise lightness to 55%, 75% opacity
  const hDeg = Math.round(h * 360);
  const sMuted = Math.min(Math.round(s * 100), 50);
  const lMuted = Math.max(Math.round(l * 100), 48);
  return `hsla(${hDeg}, ${sMuted}%, ${lMuted}%, 0.75)`;
};

export const boardOptions = [
  { label: 'All', value: 'all' },
  ...BOARD_TYPES.map((boardType) => ({
    label: formatBoardDisplayName(boardType),
    value: boardType,
  })),
];

export const unifiedTimeframeOptions: { label: string; value: UnifiedTimeframeType }[] = [
  { label: 'All', value: 'all' },
  { label: 'Year', value: 'lastYear' },
  { label: 'Month', value: 'lastMonth' },
  { label: 'Week', value: 'lastWeek' },
  { label: 'Today', value: 'today' },
  { label: 'Custom', value: 'custom' },
];
