'use client';

import React from 'react';
import { PieChart } from '@mui/x-charts/PieChart';

const FLASH_COLOR = 'rgba(75,192,192,0.7)';
const SEND_COLOR = 'rgba(192,75,75,0.7)';
const ATTEMPT_COLOR = 'rgba(158,158,158,0.7)';

interface OutcomeDoughnutProps {
  flashes: number;
  sends: number;
  attempts: number;
  height?: number;
  /** Compact mode: no legend, no tooltips */
  compact?: boolean;
}

export default function OutcomeDoughnut({
  flashes,
  sends,
  attempts,
  height = 100,
  compact = false,
}: OutcomeDoughnutProps) {
  const total = flashes + sends + attempts;
  if (total === 0) return null;

  const data = [
    { id: 'flash', value: flashes, color: FLASH_COLOR, label: 'Flash' },
    { id: 'send', value: sends, color: SEND_COLOR, label: 'Redpoint' },
    { id: 'attempt', value: attempts, color: ATTEMPT_COLOR, label: 'Attempt' },
  ].filter((d) => d.value > 0);

  return (
    <div data-testid="outcome-doughnut" style={{ height }}>
      <PieChart
        series={[{
          data,
          innerRadius: '55%',
          paddingAngle: 1,
        }]}
        height={height}
        margin={{ top: 0, bottom: 0, left: 0, right: compact ? 0 : 100 }}
        hideLegend={compact}
        slotProps={{
          legend: {
            direction: 'vertical',
            sx: { fontSize: 11 },
          },
        }}
      />
    </div>
  );
}
