'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { BarChart } from '@mui/x-charts/BarChart';

export interface BarSegment {
  value: number;
  color: string;
  label?: string;
}

export interface CssBarChartBar {
  key: string;
  label: string;
  segments: BarSegment[];
}

interface CssBarChartProps {
  bars: CssBarChartBar[];
  height?: number;
  mobileHeight?: number;
  showLegend?: boolean;
  gap?: number;
  ariaLabel?: string;
  /** Max number of x-axis labels to display; surplus labels are hidden. */
  maxLabels?: number;
  /** Render x-axis labels at a -45° angle (useful for dense charts). */
  angledLabels?: boolean;
}

export const CssBarChart = React.memo(function CssBarChart({
  bars,
  height = 48,
  mobileHeight = 36,
  showLegend = true,
  ariaLabel = 'Bar chart',
  maxLabels,
  angledLabels = false,
}: CssBarChartProps) {
  // Pivot data: bars have segments, MUI wants series (one per unique segment label/color)
  const { series, categories } = useMemo(() => {
    if (bars.length === 0) return { series: [], categories: [] };

    const cats = bars.map((b) => b.label);

    // Collect unique segment slots by index (segments are positional across bars)
    const maxSegments = Math.max(...bars.map((b) => b.segments.length));
    const seriesArr: Array<{
      data: (number | null)[];
      stack: string;
      color: string;
      label: string;
    }> = [];

    for (let i = 0; i < maxSegments; i++) {
      // Use the first bar's segment at this index for color/label
      const refSegment = bars.find((b) => b.segments[i])?.segments[i];
      if (!refSegment) continue;

      seriesArr.push({
        data: bars.map((b) => (b.segments[i]?.value ?? null)),
        stack: 'total',
        color: refSegment.color,
        label: refSegment.label ?? `Series ${i + 1}`,
      });
    }

    return { series: seriesArr, categories: cats };
  }, [bars]);

  // Compute which tick indices to show when maxLabels is set
  const tickInterval = useMemo(() => {
    if (!maxLabels || categories.length <= maxLabels) return undefined;
    const count = Math.min(maxLabels, categories.length);
    if (count <= 1) return (_value: unknown, index: number) => index === 0;
    const step = (categories.length - 1) / (count - 1);
    const indices = new Set<number>();
    for (let k = 0; k < count; k++) {
      indices.add(Math.round(k * step));
    }
    return (_value: unknown, index: number) => indices.has(index);
  }, [categories.length, maxLabels]);

  if (bars.length === 0) {
    return <div role="img" aria-label={ariaLabel} />;
  }

  const bottomMargin = showLegend ? (angledLabels ? 40 : 24) : 4;

  return (
    <Box
      role="img"
      aria-label={ariaLabel}
      sx={{
        height: `${height}px`,
        '@media (max-width: 768px)': {
          height: `${mobileHeight}px`,
        },
      }}
    >
      <BarChart
        series={series}
        xAxis={[{
          data: categories,
          scaleType: 'band' as const,
          ...(tickInterval ? { tickInterval } : {}),
          tickLabelStyle: angledLabels
            ? { angle: -45, textAnchor: 'end', fontSize: 9 }
            : { fontSize: 9 },
        }]}
        height={height}
        margin={{ top: 4, bottom: bottomMargin, left: 0, right: 0 }}
        yAxis={[{ position: 'none' }]}
        hideLegend
        slotProps={{
          bar: {
            rx: 2,
            ry: 2,
          },
        }}
      />
    </Box>
  );
});

/* Grouped (side-by-side) bar chart for flash vs redpoint */
export interface GroupedBar {
  key: string;
  label: string;
  values: Array<{ value: number; color: string; label: string }>;
}

interface GroupedBarChartProps {
  bars: GroupedBar[];
  height?: number;
  mobileHeight?: number;
  showLegend?: boolean;
  gap?: number;
  ariaLabel?: string;
}

export const GroupedBarChart = React.memo(function GroupedBarChart({
  bars,
  height = 48,
  mobileHeight = 36,
  showLegend = true,
  ariaLabel = 'Grouped bar chart',
}: GroupedBarChartProps) {
  const { series, categories, legendEntries } = useMemo(() => {
    if (bars.length === 0) return { series: [], categories: [], legendEntries: [] };

    const cats = bars.map((b) => b.label);

    // Collect unique value labels across all bars
    const seen = new Map<string, string>();
    for (const bar of bars) {
      for (const v of bar.values) {
        if (!seen.has(v.label)) seen.set(v.label, v.color);
      }
    }

    const legends = Array.from(seen.entries()).map(([label, color]) => ({ label, color }));

    // Build one series per unique value label
    const seriesArr = legends.map(({ label, color }) => ({
      data: bars.map((b) => {
        const v = b.values.find((val) => val.label === label);
        return v?.value ?? null;
      }),
      color,
      label,
    }));

    return { series: seriesArr, categories: cats, legendEntries: legends };
  }, [bars]);

  if (bars.length === 0) {
    return <div role="img" aria-label={ariaLabel} />;
  }

  return (
    <Box
      role="img"
      aria-label={ariaLabel}
      sx={{
        height: `${height}px`,
        '@media (max-width: 768px)': {
          height: `${mobileHeight}px`,
        },
      }}
    >
      <BarChart
        series={series}
        xAxis={[{
          data: categories,
          scaleType: 'band' as const,
          tickLabelStyle: { fontSize: 9 },
        }]}
        height={height}
        margin={{ top: 4, bottom: 24, left: 0, right: 0 }}
        yAxis={[{ position: 'none' }]}
        hideLegend
        slotProps={{
          bar: {
            rx: 2,
            ry: 2,
          },
        }}
      />
      {showLegend && legendEntries.length > 1 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          {legendEntries.map((entry) => (
            <Box key={entry.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: entry.color, flexShrink: 0 }} />
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '11px' }}>
                {entry.label}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
});
