'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { LineChart } from '@mui/x-charts/LineChart';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  CLIMB_STATS_HISTORY,
  type ClimbStatsHistoryEntry,
  type ClimbStatsHistoryResponse,
} from '@/app/lib/graphql/operations/climb-stats-history';
import { themeTokens } from '@/app/theme/theme-config';

// Consistent color palette for angle lines, using design tokens
const ANGLE_COLORS = [
  themeTokens.colors.primary,
  themeTokens.colors.success,
  themeTokens.colors.warning,
  themeTokens.syntax.keyword,
  themeTokens.colors.purple,
  themeTokens.colors.pink,
  themeTokens.syntax.type,
  themeTokens.syntax.string,
];

function getAngleColor(index: number): string {
  return ANGLE_COLORS[index % ANGLE_COLORS.length];
}

interface GroupedData {
  byAngle: Map<number, { date: string; value: number }[]>;
  labels: string[];
}

function groupByAngleAndMonth(
  rows: ClimbStatsHistoryEntry[],
  valueKey: 'ascensionistCount' | 'qualityAverage',
): GroupedData {
  const angleMap = new Map<number, Map<string, number[]>>();

  for (const row of rows) {
    const val = row[valueKey];
    if (val == null) continue;

    if (!angleMap.has(row.angle)) {
      angleMap.set(row.angle, new Map());
    }
    const monthMap = angleMap.get(row.angle)!;
    const month = row.createdAt.slice(0, 7);

    if (!monthMap.has(month)) {
      monthMap.set(month, []);
    }
    monthMap.get(month)!.push(val);
  }

  const allMonths = new Set<string>();
  for (const monthMap of angleMap.values()) {
    for (const month of monthMap.keys()) {
      allMonths.add(month);
    }
  }
  const labels = Array.from(allMonths).sort();

  const byAngle = new Map<number, { date: string; value: number }[]>();
  for (const [angle, monthMap] of angleMap) {
    const points: { date: string; value: number }[] = [];
    for (const month of labels) {
      const values = monthMap.get(month);
      if (values && values.length > 0) {
        // Take the last snapshot per month (most recent sync captures the latest stats)
        points.push({ date: month, value: values[values.length - 1] });
      }
    }
    byAngle.set(angle, points);
  }

  return { byAngle, labels };
}

function formatMonthLabel(yyyymm: string): string {
  const [year, month] = yyyymm.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[parseInt(month, 10) - 1]} ${year.slice(2)}`;
}

interface AngleFilterProps {
  angles: number[];
  selected: Set<number>;
  onToggle: (angle: number) => void;
}

function AngleFilter({ angles, selected, onToggle }: AngleFilterProps) {
  if (angles.length <= 1) return null;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
      {angles.map((angle, i) => (
        <Chip
          key={angle}
          label={`${angle}°`}
          size="small"
          variant={selected.has(angle) ? 'filled' : 'outlined'}
          onClick={() => onToggle(angle)}
          sx={{
            backgroundColor: selected.has(angle) ? getAngleColor(i) : undefined,
            color: selected.has(angle) ? '#fff' : undefined,
            borderColor: getAngleColor(i),
            '&:hover': {
              backgroundColor: selected.has(angle) ? getAngleColor(i) : undefined,
              opacity: 0.85,
            },
          }}
        />
      ))}
    </Box>
  );
}

interface ClimbAnalyticsProps {
  climbUuid: string;
  boardType: string;
}

export default function ClimbAnalytics({ climbUuid, boardType }: ClimbAnalyticsProps) {
  const [rows, setRows] = useState<ClimbStatsHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedAngles, setSelectedAngles] = useState<Set<number> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      try {
        const client = createGraphQLHttpClient();
        const data = await client.request<ClimbStatsHistoryResponse>(
          CLIMB_STATS_HISTORY,
          { boardName: boardType, climbUuid },
        );
        if (!cancelled) {
          setRows(data.climbStatsHistory);
          const angles = new Set(data.climbStatsHistory.map((r: ClimbStatsHistoryEntry) => r.angle));
          setSelectedAngles(angles);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchHistory();
    return () => { cancelled = true; };
  }, [climbUuid, boardType]);

  const allAngles = useMemo(() => {
    if (!rows) return [];
    const angles: number[] = Array.from(new Set(rows.map((r: ClimbStatsHistoryEntry) => r.angle)));
    return angles.sort((a, b) => a - b);
  }, [rows]);

  const handleToggleAngle = (angle: number) => {
    setSelectedAngles((prev: Set<number> | null) => {
      const next = new Set(prev);
      if (next.has(angle)) {
        if (next.size > 1) next.delete(angle);
      } else {
        next.add(angle);
      }
      return next;
    });
  };

  const filteredAngles = useMemo(() => {
    if (!selectedAngles) return allAngles;
    return allAngles.filter((a: number) => selectedAngles.has(a));
  }, [allAngles, selectedAngles]);

  const ascentsData = useMemo(() => {
    if (!rows) return null;
    return groupByAngleAndMonth(rows, 'ascensionistCount');
  }, [rows]);

  const qualityData = useMemo(() => {
    if (!rows) return null;
    return groupByAngleAndMonth(rows, 'qualityAverage');
  }, [rows]);

  const totalAscentsData = useMemo(() => {
    if (!ascentsData) return null;
    const { labels } = ascentsData;
    const totals: number[] = labels.map((month: string) => {
      let sum = 0;
      for (const angle of filteredAngles) {
        const points = ascentsData.byAngle.get(angle);
        const point = points?.find((p: { date: string; value: number }) => p.date === month);
        if (point) sum += point.value;
      }
      return sum;
    });
    return { labels, totals };
  }, [ascentsData, filteredAngles]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error || !rows || rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
        No analytics data available yet. Data is collected during sync.
      </Typography>
    );
  }

  function buildLineSeries(grouped: GroupedData) {
    return filteredAngles
      .filter((angle: number) => grouped.byAngle.has(angle))
      .map((angle: number) => {
        const colorIndex = allAngles.indexOf(angle);
        const points = grouped.byAngle.get(angle)!;

        return {
          data: grouped.labels.map((month: string) => {
            const point = points.find((p: { date: string; value: number }) => p.date === month);
            return point?.value ?? null;
          }),
          label: `${angle}°`,
          color: getAngleColor(colorIndex),
          curve: 'linear' as const,
          showMark: true,
          connectNulls: true,
        };
      });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <AngleFilter angles={allAngles} selected={selectedAngles ?? new Set()} onToggle={handleToggleAngle} />

      {ascentsData && ascentsData.labels.length > 0 && (
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Ascents Over Time</Typography>
          <LineChart
            series={buildLineSeries(ascentsData)}
            xAxis={[{
              data: ascentsData.labels.map(formatMonthLabel),
              scaleType: 'band' as const,
              tickLabelStyle: { fontSize: 10 },
            }]}
            yAxis={[{
              label: 'Ascents',
              tickLabelStyle: { fontSize: 10 },
            }]}
            height={220}
            margin={{ top: 10, bottom: 30, left: 40, right: 10 }}
            hideLegend={filteredAngles.length <= 1}
            slotProps={{
              legend: {
                sx: { fontSize: 11 },
              },
            }}
          />
        </Box>
      )}

      {qualityData && qualityData.labels.length > 0 && (
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Quality Over Time</Typography>
          <LineChart
            series={buildLineSeries(qualityData)}
            xAxis={[{
              data: qualityData.labels.map(formatMonthLabel),
              scaleType: 'band' as const,
              tickLabelStyle: { fontSize: 10 },
            }]}
            yAxis={[{
              label: 'Rating',
              tickLabelStyle: { fontSize: 10 },
            }]}
            height={220}
            margin={{ top: 10, bottom: 30, left: 40, right: 10 }}
            hideLegend={filteredAngles.length <= 1}
            slotProps={{
              legend: {
                sx: { fontSize: 11 },
              },
            }}
          />
        </Box>
      )}

      {totalAscentsData && totalAscentsData.labels.length > 0 && (
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Total Ascents (All Angles)</Typography>
          <LineChart
            series={[{
              data: totalAscentsData.totals,
              label: 'Total Ascents',
              color: themeTokens.colors.primary,
              area: true,
              curve: 'linear' as const,
              showMark: true,
            }]}
            xAxis={[{
              data: totalAscentsData.labels.map(formatMonthLabel),
              scaleType: 'band' as const,
              tickLabelStyle: { fontSize: 10 },
            }]}
            yAxis={[{
              label: 'Total Ascents',
              tickLabelStyle: { fontSize: 10 },
            }]}
            height={220}
            margin={{ top: 10, bottom: 30, left: 40, right: 10 }}
            hideLegend
          />
        </Box>
      )}
    </Box>
  );
}
