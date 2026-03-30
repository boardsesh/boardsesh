import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock chart.js and react-chartjs-2 since they use canvas
vi.mock('react-chartjs-2', () => ({
  Bar: (props: { data: unknown }) => (
    <div data-testid="chart-bar" data-data={JSON.stringify(props.data)} />
  ),
}));

vi.mock('../chart-registry', () => ({}));

// Mock the useGradeFormat hook
const mockFormatGrade = vi.fn((grade: string | null | undefined) => {
  if (!grade) return null;
  // Extract V-grade by default (mimicking v-grade format)
  const vGradeMatch = grade.match(/V\d+/i);
  return vGradeMatch ? vGradeMatch[0].toUpperCase() : grade;
});

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: mockFormatGrade,
    getGradeColor: vi.fn(),
    loaded: true,
    setGradeFormat: vi.fn(),
  }),
}));

import GradeDistributionBar from '../grade-distribution-bar';

beforeEach(() => {
  mockFormatGrade.mockClear();
});

describe('GradeDistributionBar', () => {
  it('renders with data', () => {
    const gradeDistribution = [
      { grade: 'V3', flash: 2, send: 3, attempt: 1 },
      { grade: 'V5', flash: 1, send: 1, attempt: 0 },
    ];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} />);
    expect(screen.getByTestId('grade-distribution-bar')).toBeTruthy();
    expect(screen.getByTestId('chart-bar')).toBeTruthy();
  });

  it('returns null for empty data', () => {
    const { container } = render(<GradeDistributionBar gradeDistribution={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('passes compact options when compact=true', () => {
    const gradeDistribution = [{ grade: 'V3', flash: 1, send: 2, attempt: 0 }];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} compact />);
    expect(screen.getByTestId('chart-bar')).toBeTruthy();
  });

  it('includes attempt dataset when showAttempts=true', () => {
    const gradeDistribution = [{ grade: 'V3', flash: 1, send: 2, attempt: 3 }];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} showAttempts />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    expect(data.datasets).toHaveLength(3); // Flash, Send, Attempt
    expect(data.datasets[2].label).toBe('Attempt');
    expect(data.datasets[2].data).toEqual([3]);
  });

  it('excludes attempt dataset when showAttempts=false', () => {
    const gradeDistribution = [{ grade: 'V3', flash: 1, send: 2, attempt: 3 }];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} showAttempts={false} />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    expect(data.datasets).toHaveLength(2); // Flash, Send only
  });

  it('renders grade labels on x-axis using formatGrade hook', () => {
    const gradeDistribution = [
      { grade: '6a+/V3', flash: 1, send: 1, attempt: 0 },
      { grade: '6a/V3', flash: 2, send: 3, attempt: 1 },
    ];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    // Data is reversed (hardest-first → easiest-first)
    // Mock returns V-grade extracted from the string
    expect(data.labels).toEqual(['V3', 'V3']);
    // Verify formatGrade was called for each grade
    expect(mockFormatGrade).toHaveBeenCalledWith('6a/V3');
    expect(mockFormatGrade).toHaveBeenCalledWith('6a+/V3');
  });

  it('uses formatGrade hook for grade formatting', () => {
    const gradeDistribution = [
      { grade: '7a+/V7', flash: 0, send: 1, attempt: 0 },
      { grade: '7a/V6', flash: 1, send: 0, attempt: 0 },
    ];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    expect(data.labels).toEqual(['V6', 'V7']);
  });
});
