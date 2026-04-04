'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { TENSION_KILTER_GRADES } from '@/app/lib/board-data';
import { themeTokens } from '@/app/theme/theme-config';
import { CssBarChart } from '@/app/components/charts/css-bar-chart';
import type { CssBarChartBar } from '@/app/components/charts/css-bar-chart';
import { PlannedClimbSlot } from './types';

interface GradeProgressionChartProps {
  plannedSlots: PlannedClimbSlot[];
  height?: number;
}

function getGradeName(difficultyId: number): string {
  return TENSION_KILTER_GRADES.find((g) => g.difficulty_id === difficultyId)?.difficulty_name ?? `Grade ${difficultyId}`;
}

const GradeProgressionChart: React.FC<GradeProgressionChartProps> = ({
  plannedSlots,
  height = 120,
}) => {
  const bars: CssBarChartBar[] = useMemo(() => {
    if (plannedSlots.length === 0) return [];

    // Count climbs per grade
    const gradeCounts = new Map<number, number>();
    for (const slot of plannedSlots) {
      gradeCounts.set(slot.grade, (gradeCounts.get(slot.grade) ?? 0) + 1);
    }

    // Sort by difficulty_id ascending
    const sortedGrades = Array.from(gradeCounts.keys()).sort((a, b) => a - b);

    return sortedGrades.map((gradeId) => ({
      key: String(gradeId),
      label: getGradeName(gradeId),
      segments: [{
        value: gradeCounts.get(gradeId)!,
        color: themeTokens.colors.primary,
      }],
    }));
  }, [plannedSlots]);

  if (plannedSlots.length === 0) {
    return (
      <Box
        sx={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'var(--neutral-50)',
          borderRadius: 2,
          border: '1px dashed var(--neutral-300)',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          Configure options to preview
        </Typography>
      </Box>
    );
  }

  return (
    <CssBarChart
      bars={bars}
      height={height}
      mobileHeight={height}
      showLegend
      ariaLabel="Grade distribution preview"
    />
  );
};

export default GradeProgressionChart;
