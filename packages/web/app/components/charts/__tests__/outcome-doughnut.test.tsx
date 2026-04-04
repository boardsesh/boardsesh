import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock MUI X Charts PieChart
vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: (props: { series: Array<{ data: unknown[] }> }) => (
    <div
      data-testid="mui-pie-chart"
      data-series={JSON.stringify(props.series)}
    />
  ),
}));

import OutcomeDoughnut from '../outcome-doughnut';

describe('OutcomeDoughnut', () => {
  it('renders with data', () => {
    render(<OutcomeDoughnut flashes={3} sends={5} attempts={2} />);
    expect(screen.getByTestId('outcome-doughnut')).toBeTruthy();
    expect(screen.getByTestId('mui-pie-chart')).toBeTruthy();
  });

  it('returns null when all values are zero', () => {
    const { container } = render(<OutcomeDoughnut flashes={0} sends={0} attempts={0} />);
    expect(container.innerHTML).toBe('');
  });

  it('passes correct data segments', () => {
    render(<OutcomeDoughnut flashes={3} sends={5} attempts={2} />);
    const chartEl = screen.getByTestId('mui-pie-chart');
    const series = JSON.parse(chartEl.getAttribute('data-series') ?? '[]');
    const data = series[0].data;
    expect(data).toHaveLength(3);
    expect(data.map((d: { value: number }) => d.value)).toEqual([3, 5, 2]);
    expect(data.map((d: { label: string }) => d.label)).toEqual(['Flash', 'Redpoint', 'Attempt']);
  });

  it('filters out zero-value segments', () => {
    render(<OutcomeDoughnut flashes={0} sends={4} attempts={0} />);
    expect(screen.getByTestId('outcome-doughnut')).toBeTruthy();
    const chartEl = screen.getByTestId('mui-pie-chart');
    const series = JSON.parse(chartEl.getAttribute('data-series') ?? '[]');
    const data = series[0].data;
    expect(data).toHaveLength(1);
    expect(data[0].value).toBe(4);
    expect(data[0].label).toBe('Redpoint');
  });
});
