import {
  FONT_GRADE_COLORS,
  V_GRADE_COLORS,
  getGradeColorWithOpacity,
  type GradeDisplayFormat,
} from '@/app/lib/grade-colors';
import { SUPPORTED_BOARDS } from '@/app/lib/board-data';

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

// Font grade mapping (uppercase for display)
const fontGradeMapping: Record<number, string> = {
  10: '4A',
  11: '4B',
  12: '4C',
  13: '5A',
  14: '5B',
  15: '5C',
  16: '6A',
  17: '6A+',
  18: '6B',
  19: '6B+',
  20: '6C',
  21: '6C+',
  22: '7A',
  23: '7A+',
  24: '7B',
  25: '7B+',
  26: '7C',
  27: '7C+',
  28: '8A',
  29: '8A+',
  30: '8B',
  31: '8B+',
  32: '8C',
  33: '8C+',
};

// V-grade mapping
const vGradeMapping: Record<number, string> = {
  10: 'V0',
  11: 'V0',
  12: 'V0',
  13: 'V1',
  14: 'V1',
  15: 'V2',
  16: 'V3',
  17: 'V3+',
  18: 'V4',
  19: 'V4+',
  20: 'V5',
  21: 'V5+',
  22: 'V6',
  23: 'V7',
  24: 'V8',
  25: 'V8+',
  26: 'V9',
  27: 'V10',
  28: 'V11',
  29: 'V12',
  30: 'V13',
  31: 'V14',
  32: 'V15',
  33: 'V16',
};

// Default mapping (for backwards compatibility - uses Font grades)
export const difficultyMapping: Record<number, string> = fontGradeMapping;

// Get difficulty mapping based on format preference
export const getDifficultyMapping = (format: GradeDisplayFormat): Record<number, string> => {
  return format === 'v-grade' ? vGradeMapping : fontGradeMapping;
};

// Build reverse mapping from grade string to numeric difficulty for sorting
const buildGradeOrder = (mapping: Record<number, string>): Map<string, number> => {
  const order = new Map<string, number>();
  for (const [numStr, grade] of Object.entries(mapping)) {
    const num = parseInt(numStr, 10);
    // For grades that map to the same string (e.g., V0 from 10, 11, 12), keep the lowest number
    if (!order.has(grade) || num < (order.get(grade) ?? Infinity)) {
      order.set(grade, num);
    }
  }
  return order;
};

const fontGradeOrder = buildGradeOrder(fontGradeMapping);
const vGradeOrder = buildGradeOrder(vGradeMapping);

// Sort grades by their numeric difficulty value
export const sortGrades = (grades: string[], format: GradeDisplayFormat): string[] => {
  const gradeOrder = format === 'v-grade' ? vGradeOrder : fontGradeOrder;
  return [...grades].sort((a, b) => {
    const orderA = gradeOrder.get(a) ?? 999;
    const orderB = gradeOrder.get(b) ?? 999;
    return orderA - orderB;
  });
};

export const angleColors = [
  'rgba(255,77,77,0.7)',
  'rgba(51,0,102,1)',
  'rgba(77,128,255,0.7)',
  'rgba(255,204,51,0.7)',
  'rgba(204,51,153,0.7)',
  'rgba(51,204,204,0.7)',
  'rgba(255,230,25,0.7)',
  'rgba(102,102,255,0.7)',
  'rgba(51,153,255,0.7)',
  'rgba(25,179,255,0.7)',
  'rgba(255,255,51,0.7)',
  'rgba(102,51,153,1)',
  'rgba(179,255,128,0.7)',
];

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

// Colors for each layout
const layoutColors: Record<string, string> = {
  'kilter-1': 'rgba(6, 182, 212, 0.7)',
  'kilter-8': 'rgba(57, 255, 20, 0.7)',
  'tension-9': 'rgba(239, 68, 68, 0.7)',
  'tension-10': 'rgba(249, 115, 22, 0.7)',
  'tension-11': 'rgba(234, 179, 8, 0.7)',
  'moonboard-1': 'rgba(255, 215, 0, 0.7)',
  'moonboard-2': 'rgba(255, 165, 0, 0.7)',
  'moonboard-3': 'rgba(255, 140, 0, 0.7)',
  'moonboard-4': 'rgba(255, 193, 7, 0.7)',
  'moonboard-5': 'rgba(255, 152, 0, 0.7)',
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

export const getGradeChartColor = (grade: string): string => {
  // Check V-grade first (e.g., "V3", "V5+")
  const normalizedVGrade = grade.toUpperCase().replace(/\+$/, '');
  if (V_GRADE_COLORS[normalizedVGrade]) {
    return getGradeColorWithOpacity(V_GRADE_COLORS[normalizedVGrade], 0.8);
  }
  // Then check Font grade (e.g., "6A", "7C+")
  const hexColor = FONT_GRADE_COLORS[grade.toLowerCase()];
  return hexColor ? getGradeColorWithOpacity(hexColor, 0.8) : 'rgba(200, 200, 200, 0.7)';
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
