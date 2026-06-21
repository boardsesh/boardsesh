import { describe, expect, it } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar } from '../profile-chart-colors';
import {
  createGroupedTooltipModel,
  createStackedTooltipModel,
  getGroupedBarsMaxValue,
  getStackedBarsMaxValue,
} from '../chart-model';

describe('chart-model', () => {
  const stackedBars: ColoredBar[] = [
    {
      key: 'week-1',
      label: 'W1',
      segments: [
        { key: 'V2', label: 'V2', value: 2, color: '#111111' },
        { key: 'V3', label: 'V3', value: 3, color: '#222222' },
      ],
    },
    {
      key: 'week-2',
      label: 'W2',
      segments: [
        { key: 'V2', label: 'V2', value: 1, color: '#111111' },
        { key: 'V3', label: 'V3', value: 0, color: '#222222' },
      ],
    },
  ];

  it('fits stacked y-axis max to the tallest rendered stack', () => {
    expect(getStackedBarsMaxValue(stackedBars)).toBe(5);
    expect(getStackedBarsMaxValue([])).toBe(1);
    expect(getStackedBarsMaxValue(null)).toBe(1);
  });

  it('builds stacked tooltip rows from non-zero segments', () => {
    const tooltip = createStackedTooltipModel(stackedBars[0], (segment) => segment.color ?? '#000000');
    expect(tooltip).toEqual({
      title: 'W1',
      total: 5,
      rows: [
        { label: 'V2', value: 2, color: '#111111' },
        { label: 'V3', value: 3, color: '#222222' },
      ],
    });
  });

  it('fits grouped y-axis max to the largest individual grouped value', () => {
    const groupedBars: RawGroupedBar[] = [
      {
        key: 'V4',
        label: 'V4',
        values: [
          { key: 'flash', label: 'Flash', value: 2 },
          { key: 'redpoint', label: 'Redpoint', value: 7 },
        ],
      },
    ];

    expect(getGroupedBarsMaxValue(groupedBars)).toBe(7);
    expect(getGroupedBarsMaxValue([])).toBe(1);
  });

  it('builds grouped tooltip rows from non-zero grouped values', () => {
    const tooltip = createGroupedTooltipModel(
      {
        key: 'V5',
        label: 'V5',
        values: [
          { key: 'flash', label: 'Flash', value: 0 },
          { key: 'redpoint', label: 'Redpoint', value: 4 },
        ],
      },
      (key) => (key === 'flash' ? '#00aa00' : '#cc0000'),
    );

    expect(tooltip).toEqual({
      title: 'V5',
      total: 4,
      rows: [{ label: 'Redpoint', value: 4, color: '#cc0000' }],
    });
  });
});
