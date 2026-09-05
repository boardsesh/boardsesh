// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Profile statistics types

export type GradeCount = {
  grade: string;
  count: number;
};

export type LayoutStats = {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  distinctClimbCount: number;
  gradeCounts: GradeCount[];
};

export type ProfileStats = {
  totalDistinctClimbs: number;
  layoutStats: LayoutStats[];
};

export type UserClimbPercentile = {
  totalDistinctClimbs: number;
  percentile: number;
  totalActiveUsers: number;
};
