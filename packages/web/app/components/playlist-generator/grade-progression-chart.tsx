'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { getGradesForBoard } from '@/app/lib/board-data';
import { CssBarChart, type CssBarChartBar } from '@/app/components/charts/css-bar-chart';
import type { BoardDetails } from '@/app/lib/types';
import type { PlannedClimbSlot } from './types';

type GradeProgressionChartProps = {
  plannedSlots: PlannedClimbSlot[];
  boardDetails: BoardDetails;
  height?: number;
};

function getGradeName(difficultyId: number, grades: ReturnType<typeof getGradesForBoard>): string {
  return grades.find((grade) => grade.difficulty_id === difficultyId)?.difficulty_name ?? `Grade ${difficultyId}`;
}

const GradeProgressionChart: React.FC<GradeProgressionChartProps> = ({ plannedSlots, boardDetails, height = 120 }) => {
  const { t } = useTranslation('playlists');
  const theme = useTheme();
  const barColor = theme.palette.primaryFill.main;
  const grades = useMemo(() => getGradesForBoard(boardDetails.board_name), [boardDetails.board_name]);
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
      label: getGradeName(gradeId, grades),
      segments: [
        {
          value: gradeCounts.get(gradeId)!,
          color: barColor,
        },
      ],
    }));
  }, [plannedSlots, grades, barColor]);

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
          {t('generator.chart.configurePrompt')}
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
      ariaLabel={t('generator.chart.ariaLabel')}
    />
  );
};

export default GradeProgressionChart;
