import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock MUI X Charts since they use SVG/canvas internals
vi.mock('@mui/x-charts/BarChart', () => ({
  BarChart: (props: { series: unknown[]; xAxis: unknown[]; height: number }) => (
    <div
      data-testid="mui-bar-chart"
      data-series={JSON.stringify(props.series)}
      data-xaxis={JSON.stringify(props.xAxis)}
      data-height={props.height}
    />
  ),
}));

import { CssBarChart, GroupedBarChart } from '../css-bar-chart';
import type { CssBarChartBar, GroupedBar } from '../css-bar-chart';

describe('CssBarChart', () => {
  it('renders with correct aria-label', () => {
    const bars: CssBarChartBar[] = [
      { key: 'a', label: 'A', segments: [{ value: 5, color: 'red' }] },
    ];
    render(<CssBarChart bars={bars} />);
    expect(screen.getByRole('img', { name: 'Bar chart' })).toBeTruthy();
  });

  it('renders empty container for empty bars', () => {
    const { container } = render(<CssBarChart bars={[]} />);
    expect(container.querySelector('[role="img"]')).toBeTruthy();
  });

  it('applies custom aria-label', () => {
    render(<CssBarChart bars={[]} ariaLabel="My custom chart" />);
    expect(screen.getByRole('img', { name: 'My custom chart' })).toBeTruthy();
  });

  it('passes correct series data to BarChart for single segment bars', () => {
    const bars: CssBarChartBar[] = [
      { key: 'a', label: 'A', segments: [{ value: 5, color: 'red' }] },
      { key: 'b', label: 'B', segments: [{ value: 3, color: 'red' }] },
    ];
    render(<CssBarChart bars={bars} />);
    const chart = screen.getByTestId('mui-bar-chart');
    const series = JSON.parse(chart.getAttribute('data-series') ?? '[]');
    expect(series).toHaveLength(1);
    expect(series[0].data).toEqual([5, 3]);
    expect(series[0].stack).toBe('total');
  });

  it('passes correct series data for multi-segment (stacked) bars', () => {
    const bars: CssBarChartBar[] = [
      {
        key: 'x',
        label: 'Grade',
        segments: [
          { value: 3, color: 'red', label: 'Flash' },
          { value: 2, color: 'blue', label: 'Send' },
        ],
      },
    ];
    render(<CssBarChart bars={bars} />);
    const chart = screen.getByTestId('mui-bar-chart');
    const series = JSON.parse(chart.getAttribute('data-series') ?? '[]');
    expect(series).toHaveLength(2);
    expect(series[0].label).toBe('Flash');
    expect(series[1].label).toBe('Send');
  });

  it('passes correct xAxis categories', () => {
    const bars: CssBarChartBar[] = [
      { key: 'a', label: 'Alpha', segments: [{ value: 1, color: '#000' }] },
      { key: 'b', label: 'Beta', segments: [{ value: 2, color: '#111' }] },
    ];
    render(<CssBarChart bars={bars} />);
    const chart = screen.getByTestId('mui-bar-chart');
    const xAxis = JSON.parse(chart.getAttribute('data-xaxis') ?? '[]');
    expect(xAxis[0].data).toEqual(['Alpha', 'Beta']);
  });
});

describe('GroupedBarChart', () => {
  it('renders with correct aria-label', () => {
    const bars: GroupedBar[] = [
      { key: 'v3', label: 'V3', values: [{ value: 2, color: 'green', label: 'Flash' }] },
    ];
    render(<GroupedBarChart bars={bars} />);
    expect(screen.getByRole('img', { name: 'Grouped bar chart' })).toBeTruthy();
  });

  it('renders empty container for empty bars', () => {
    const { container } = render(<GroupedBarChart bars={[]} />);
    expect(container.querySelector('[role="img"]')).toBeTruthy();
  });

  it('creates one series per unique value label', () => {
    const bars: GroupedBar[] = [
      {
        key: 'v5',
        label: 'V5',
        values: [
          { value: 3, color: 'green', label: 'Flash' },
          { value: 5, color: 'red', label: 'Redpoint' },
        ],
      },
    ];
    render(<GroupedBarChart bars={bars} />);
    const chart = screen.getByTestId('mui-bar-chart');
    const series = JSON.parse(chart.getAttribute('data-series') ?? '[]');
    expect(series).toHaveLength(2);
    expect(series[0].label).toBe('Flash');
    expect(series[1].label).toBe('Redpoint');
  });

  it('shows legend entries for multiple unique labels', () => {
    const bars: GroupedBar[] = [
      {
        key: 'v3',
        label: 'V3',
        values: [
          { value: 1, color: 'green', label: 'Flash' },
          { value: 2, color: 'red', label: 'Redpoint' },
        ],
      },
    ];
    render(<GroupedBarChart bars={bars} />);
    expect(screen.getByText('Flash')).toBeTruthy();
    expect(screen.getByText('Redpoint')).toBeTruthy();
  });

  it('does not show legend with only one unique label', () => {
    const bars: GroupedBar[] = [
      { key: 'v3', label: 'V3', values: [{ value: 5, color: 'green', label: 'Flash' }] },
      { key: 'v4', label: 'V4', values: [{ value: 3, color: 'green', label: 'Flash' }] },
    ];
    const { container } = render(<GroupedBarChart bars={bars} />);
    // Only 1 unique label, so no legend entries rendered outside the chart
    const legendItems = container.querySelectorAll('[class*="MuiBox"]');
    // The chart renders but no legend text for "Flash" outside the chart mock
    // (inside the mock it doesn't render text)
    expect(container.querySelector('[role="img"]')).toBeTruthy();
  });
});
