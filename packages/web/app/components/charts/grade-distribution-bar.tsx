'use client';

import React from 'react';
import { Bar } from 'react-chartjs-2';
import './chart-registry'; // Ensure Chart.js components are registered
import { useGradeFormat } from '@/app/hooks/use-grade-format';

export interface GradeDistributionItem {
  grade: string;
  flash?: number;
  send?: number;
  attempt?: number;
  count?: number;
}

interface GradeDistributionBarProps {
  gradeDistribution: GradeDistributionItem[];
  height?: number;
  /** Compact mode for feed cards: smaller fonts, no legend/tooltips */
  compact?: boolean;
  /** Include attempt bars */
  showAttempts?: boolean;
  /** Stack bars */
  stacked?: boolean;
}

// Match profile page "Ascents by Difficulty" colors
const FLASH_COLOR = 'rgba(75,192,192,0.5)';
const SEND_COLOR = 'rgba(192,75,75,0.5)';
const ATTEMPT_COLOR = 'rgba(158,158,158,0.5)';

export default function GradeDistributionBar({
  gradeDistribution,
  height = 200,
  compact = false,
  showAttempts = true,
  stacked = true,
}: GradeDistributionBarProps) {
  const { formatGrade } = useGradeFormat();

  if (gradeDistribution.length === 0) return null;

  // Data comes sorted hardest-first from backend; reverse to show lowest→highest on x-axis
  const sorted = [...gradeDistribution].reverse();

  const labels = sorted.map((g) => formatGrade(g.grade) ?? g.grade);

  // In compact mode, use near-full width bars for a dense chart
  const barPct = compact ? 0.95 : 0.8;
  const catPct = compact ? 0.95 : 0.8;

  const datasets: Array<{
    label: string;
    data: number[];
    backgroundColor: string | string[];
    borderRadius?: number;
    barPercentage?: number;
    categoryPercentage?: number;
  }> = [
    {
      label: 'Flash',
      data: sorted.map((g) => g.flash ?? 0),
      backgroundColor: FLASH_COLOR,
      borderRadius: compact ? 1 : 2,
      barPercentage: barPct,
      categoryPercentage: catPct,
    },
    {
      label: 'Redpoint',
      data: sorted.map((g) => g.send ?? (g.count ?? 0)),
      backgroundColor: SEND_COLOR,
      borderRadius: compact ? 1 : 2,
      barPercentage: barPct,
      categoryPercentage: catPct,
    },
  ];

  if (showAttempts) {
    datasets.push({
      label: 'Attempt',
      data: sorted.map((g) => g.attempt ?? 0),
      backgroundColor: ATTEMPT_COLOR,
      borderRadius: compact ? 1 : 2,
      barPercentage: barPct,
      categoryPercentage: catPct,
    });
  }

  const data = { labels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: !compact,
        position: 'top' as const,
        ...(compact && { labels: { font: { size: 9 } } }),
      },
      title: {
        display: !compact,
        text: 'Ascents by Difficulty',
      },
      tooltip: {
        enabled: !compact,
      },
    },
    scales: {
      x: {
        type: 'category' as const,
        stacked,
        ticks: compact ? { font: { size: 9 } } : undefined,
      },
      y: {
        stacked,
        display: !compact,
        beginAtZero: true,
      },
    },
    ...(compact && { layout: { padding: 0 } }),
  };

  return (
    <div data-testid="grade-distribution-bar" style={{ height }}>
      <Bar data={data} options={options} />
    </div>
  );
}
