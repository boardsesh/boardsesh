import { describe, expect, it } from 'vitest';
import { heatMetricForBrush } from '../create-heatmap';

describe('heatMetricForBrush', () => {
  it('follows the brush, and Erase hides the heat', () => {
    expect(heatMetricForBrush('STARTING')).toBe('starts');
    expect(heatMetricForBrush('HAND')).toBe('hands');
    expect(heatMetricForBrush('FOOT')).toBe('feet');
    expect(heatMetricForBrush('FINISH')).toBe('finishes');
    expect(heatMetricForBrush('OFF')).toBeNull();
  });
});
