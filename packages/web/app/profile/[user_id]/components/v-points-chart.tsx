'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { LineChart } from '@mui/x-charts/LineChart';
import { useTranslation } from 'react-i18next';
import type { VPointsTimelineData } from '../utils/chart-data-builders';

type VPointsChartProps = {
  data: VPointsTimelineData;
};

export default function VPointsChart({ data }: VPointsChartProps) {
  const { t } = useTranslation('profile');
  const { weekLabels, series, totalPoints } = data;

  // Downsample labels for readability — show at most ~12 labels
  const labelInterval = Math.max(1, Math.floor(weekLabels.length / 12));

  // Compute stacked max for a tight y-axis (sum all series per week, add 10% headroom)
  const stackedMax = weekLabels.reduce((max, _, i) => {
    const sum = series.reduce((s, ser) => s + (ser.data[i] ?? 0), 0);
    return Math.max(max, sum);
  }, 0);
  const yMax = Math.ceil(stackedMax * 1.1);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
        <Typography
          variant="body2"
          component="span"
          fontWeight={600}
          sx={{ fontSize: 13, color: 'var(--neutral-600)' }}
        >
          {t('stats.vPoints')}
        </Typography>
        <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 12 }}>
          {t('stats.vPointsTotal', { value: totalPoints.toLocaleString() })}
        </Typography>
      </Box>
      <LineChart
        series={series.map((s) => ({
          data: s.data,
          label: s.displayName,
          color: s.color,
          area: true,
          stack: 'vpoints',
          curve: 'linear' as const,
          showMark: false,
        }))}
        xAxis={[
          {
            data: weekLabels,
            scaleType: 'band' as const,
            label: t('stats.weekAxisLabel'),
            labelStyle: { fontSize: 11 },
            tickLabelStyle: { fontSize: 11 },
            tickInterval: (_value: string, index: number) => index % labelInterval === 0,
          },
        ]}
        yAxis={[
          {
            max: yMax,
            tickLabelStyle: { fontSize: 10 },
            valueFormatter: (value: number | null) => {
              if (value == null) return '';
              if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
              return value.toString();
            },
          },
        ]}
        height={160}
        margin={{ top: 5, bottom: 48, left: 30, right: 5 }}
        hideLegend
        sx={{ width: '100%' }}
      />
    </Box>
  );
}
