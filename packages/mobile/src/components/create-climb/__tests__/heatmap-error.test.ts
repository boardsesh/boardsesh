import { describe, expect, it } from 'vitest';
import { isNewHeatmapFailure } from '../heatmap-error';

describe('isNewHeatmapFailure', () => {
  it('does not immediately re-handle a cached offline error while retrying', () => {
    expect(
      isNewHeatmapFailure({
        active: true,
        isError: true,
        isFetching: true,
        errorUpdatedAt: 100,
        handledErrorAt: 100,
      }),
    ).toBe(false);
  });

  it('handles only a newly completed failed retry', () => {
    expect(
      isNewHeatmapFailure({
        active: true,
        isError: true,
        isFetching: false,
        errorUpdatedAt: 200,
        handledErrorAt: 100,
      }),
    ).toBe(true);
    expect(
      isNewHeatmapFailure({
        active: true,
        isError: true,
        isFetching: false,
        errorUpdatedAt: 200,
        handledErrorAt: 200,
      }),
    ).toBe(false);
  });
});
