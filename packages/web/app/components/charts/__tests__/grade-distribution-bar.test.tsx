import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock chart.js and react-chartjs-2 since they use canvas
vi.mock('react-chartjs-2', () => ({
  Bar: (props: { data: unknown }) => (
    <div data-testid="chart-bar" data-data={JSON.stringify(props.data)} />
  ),
}));

vi.mock('../chart-registry', () => ({}));

import GradeDistributionBar, { formatGradeLabels } from '../grade-distribution-bar';

describe('formatGradeLabels', () => {
  it('extracts V-grade from combined Font/V-grade strings', () => {
    expect(formatGradeLabels([{ grade: '6a/V3' }, { grade: '6b/V4' }])).toEqual(['V3', 'V4']);
  });

  it('passes through bare V-grade strings', () => {
    expect(formatGradeLabels([{ grade: 'V3' }, { grade: 'V5' }])).toEqual(['V3', 'V5']);
  });

  it('adds "+" when Font grade has "+" suffix (e.g., 6c+ → V5+)', () => {
    expect(formatGradeLabels([{ grade: '6c/V5' }, { grade: '6c+/V5' }])).toEqual(['V5', 'V5+']);
  });

  it('handles mix of single and dual Font grades per V-grade', () => {
    expect(formatGradeLabels([
      { grade: '5c/V2' }, { grade: '6a/V3' }, { grade: '6a+/V3' }, { grade: '6b/V4' },
    ])).toEqual(['V2', 'V3', 'V3+', 'V4']);
  });

  it('falls back to original string when no V-grade is found and no lookup match', () => {
    // MoonBoard uppercase Font grades not in the Kilter/Tension BOULDER_GRADES lookup
    expect(formatGradeLabels([{ grade: '6A' }, { grade: '7A+' }])).toEqual(['V3', 'V7']);
  });

  it('only adds "+" when V-grade has multiple Font grades', () => {
    // 7a+/V7: V7 has only one Font grade (7a+), so no "+" needed
    expect(formatGradeLabels([{ grade: '7a/V6' }, { grade: '7a+/V7' }])).toEqual(['V6', 'V7']);
    // 6b+/V4: V4 has two Font grades (6b, 6b+), so "+" is added
    expect(formatGradeLabels([{ grade: '6b/V4' }, { grade: '6b+/V4' }])).toEqual(['V4', 'V4+']);
  });

  it('handles empty array', () => {
    expect(formatGradeLabels([])).toEqual([]);
  });

  it('converts numeric difficulty IDs to V-grades via BOULDER_GRADES lookup', () => {
    // difficulty_id 10 → V0, 13 → V1, 15 → V2
    expect(formatGradeLabels([
      { grade: '0', difficulty: 10 },
      { grade: '1', difficulty: 13 },
      { grade: '2', difficulty: 15 },
    ])).toEqual(['V0', 'V1', 'V2']);
  });

  it('converts font-grade-only strings to V-grades', () => {
    // "5a" → V1, "5c" → V2 via font grade lookup
    expect(formatGradeLabels([{ grade: '5a' }, { grade: '5c' }])).toEqual(['V1', 'V2']);
  });

  it('falls back to original string for unknown grades without difficulty', () => {
    expect(formatGradeLabels([{ grade: 'unknown' }])).toEqual(['unknown']);
  });
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

  it('renders V-grade labels on x-axis from combined Font/V-grade strings', () => {
    const gradeDistribution = [
      { grade: '6a+/V3', flash: 1, send: 1, attempt: 0 },
      { grade: '6a/V3', flash: 2, send: 3, attempt: 1 },
    ];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    // Data is reversed (hardest-first → easiest-first), so 6a/V3 comes before 6a+/V3
    expect(data.labels).toEqual(['V3', 'V3+']);
  });

  it('does not add "+" when V-grade has only one Font grade mapping', () => {
    const gradeDistribution = [
      { grade: '7a+/V7', flash: 0, send: 1, attempt: 0 },
      { grade: '7a/V6', flash: 1, send: 0, attempt: 0 },
    ];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    // V7 has only one Font grade (7a+), so no "+" is added
    expect(data.labels).toEqual(['V6', 'V7']);
  });

  it('renders V-grade labels from numeric difficulty IDs', () => {
    const gradeDistribution = [
      { grade: '2', difficulty: 15, flash: 1, send: 0, attempt: 0 },
      { grade: '0', difficulty: 10, flash: 0, send: 1, attempt: 0 },
    ];

    render(<GradeDistributionBar gradeDistribution={gradeDistribution} />);
    const chartEl = screen.getByTestId('chart-bar');
    const data = JSON.parse(chartEl.getAttribute('data-data') || '{}');
    expect(data.labels).toEqual(['V0', 'V2']);
  });
});
