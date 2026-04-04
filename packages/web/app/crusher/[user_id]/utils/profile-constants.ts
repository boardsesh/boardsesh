import { V_GRADE_COLORS } from '@/app/lib/grade-colors';
import { SUPPORTED_BOARDS, BOULDER_GRADES } from '@/app/lib/board-data';

export interface UserProfile {
  id: string;
  email: string;
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
}

export interface LogbookEntry {
  climbed_at: string;
  difficulty: number | null;
  tries: number;
  angle: number;
  status?: 'flash' | 'send' | 'attempt';
  layoutId?: number | null;
  boardType?: string;
  climbUuid?: string;
}

export type TimeframeType = 'all' | 'lastYear' | 'lastMonth' | 'lastWeek' | 'custom';
export type AggregatedTimeframeType = 'today' | 'lastWeek' | 'lastMonth' | 'lastYear' | 'all';

export const BOARD_TYPES = SUPPORTED_BOARDS;

// Maps difficulty IDs to V-grades (e.g., 16 → "V3", 17 → "V3").
// Multiple Font grades collapse into the same V-grade, which is what we want
// for chart aggregation and display labels.
export const difficultyMapping: Record<number, string> = Object.fromEntries(
  BOULDER_GRADES.map((g) => [g.difficulty_id, g.v_grade]),
);

// Layout name mapping: boardType-layoutId -> display name
const layoutNames: Record<string, string> = {
  'kilter-1': 'Kilter Original',
  'kilter-8': 'Kilter Homewall',
  'tension-9': 'Tension Classic',
  'tension-10': 'Tension 2 Mirror',
  'tension-11': 'Tension 2 Spray',
  'moonboard-1': 'MoonBoard 2010',
  'moonboard-2': 'MoonBoard 2016',
  'moonboard-3': 'MoonBoard 2024',
  'moonboard-4': 'MoonBoard Masters 2017',
  'moonboard-5': 'MoonBoard Masters 2019',
};

// Colors for each layout — soft, muted palette that feels cohesive
const layoutColors: Record<string, string> = {
  'kilter-1': 'hsla(190, 55%, 52%, 0.7)',   // Muted teal
  'kilter-8': 'hsla(160, 40%, 50%, 0.7)',    // Soft sage green
  'tension-9': 'hsla(350, 50%, 58%, 0.7)',   // Dusty rose
  'tension-10': 'hsla(20, 55%, 58%, 0.7)',   // Warm terracotta
  'tension-11': 'hsla(42, 50%, 55%, 0.7)',   // Muted gold
  'moonboard-1': 'hsla(270, 40%, 58%, 0.7)', // Soft lavender
  'moonboard-2': 'hsla(250, 40%, 55%, 0.7)', // Muted indigo
  'moonboard-3': 'hsla(290, 35%, 55%, 0.7)', // Soft plum
  'moonboard-4': 'hsla(230, 40%, 58%, 0.7)', // Dusty blue
  'moonboard-5': 'hsla(210, 45%, 55%, 0.7)', // Slate blue
};

export const getLayoutKey = (boardType: string, layoutId: number | null | undefined): string => {
  if (layoutId === null || layoutId === undefined) {
    return `${boardType}-unknown`;
  }
  return `${boardType}-${layoutId}`;
};

export const getLayoutDisplayName = (boardType: string, layoutId: number | null | undefined): string => {
  const key = getLayoutKey(boardType, layoutId);
  return layoutNames[key] || `${boardType.charAt(0).toUpperCase() + boardType.slice(1)} (Layout ${layoutId ?? 'Unknown'})`;
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
  // Strip trailing "+" so "V5+" looks up the same color as "V5"
  const normalized = grade.replace(/\+$/, '');
  const hexColor = V_GRADE_COLORS[normalized];
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

export const boardOptions = BOARD_TYPES.map((boardType) => ({
  label: boardType.charAt(0).toUpperCase() + boardType.slice(1),
  value: boardType,
}));

export const timeframeOptions = [
  { label: 'All', value: 'all' },
  { label: 'Year', value: 'lastYear' },
  { label: 'Month', value: 'lastMonth' },
  { label: 'Week', value: 'lastWeek' },
  { label: 'Custom', value: 'custom' },
];

export const aggregatedTimeframeOptions = [
  { label: 'All', value: 'all' },
  { label: 'Year', value: 'lastYear' },
  { label: 'Month', value: 'lastMonth' },
  { label: 'Week', value: 'lastWeek' },
  { label: 'Today', value: 'today' },
];
