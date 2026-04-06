import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the module-level LED placements cache pattern used in use-board-bluetooth.ts.
 *
 * The production code caches the getLedPlacements function at module scope:
 *
 *   let cachedGetLedPlacements: GetLedPlacementsFn | null = null;
 *   ...
 *   if (!cachedGetLedPlacements) {
 *     const mod = await import('@/app/lib/__generated__/led-placements-data');
 *     cachedGetLedPlacements = mod.getLedPlacements;
 *   }
 *
 * Because the cache is a module-level variable, we test the caching pattern
 * in isolation to verify correctness without coupling to the full React hook.
 */

type GetLedPlacementsFn = (boardName: string, layoutId: number, sizeId: number) => Record<number, number>;

describe('LED placements cache', () => {
  let cachedGetLedPlacements: GetLedPlacementsFn | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockImport: any;

  beforeEach(() => {
    cachedGetLedPlacements = null;
    mockImport = vi.fn();
  });

  /**
   * Simulates the lazy-load + cache logic from sendFramesToBoard.
   * Returns the cached function after loading it via the mock import.
   */
  async function loadGetLedPlacements(): Promise<GetLedPlacementsFn> {
    if (!cachedGetLedPlacements) {
      const mod = await mockImport();
      cachedGetLedPlacements = mod.getLedPlacements as GetLedPlacementsFn;
    }
    return cachedGetLedPlacements;
  }

  it('calls the dynamic import on the first load', async () => {
    const fakeFn: GetLedPlacementsFn = () => ({ 1: 0, 2: 1 });
    mockImport.mockResolvedValue({ getLedPlacements: fakeFn });

    const fn = await loadGetLedPlacements();

    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(fn).toBe(fakeFn);
  });

  it('does not call the dynamic import on subsequent loads', async () => {
    const fakeFn: GetLedPlacementsFn = () => ({ 1: 0, 2: 1 });
    mockImport.mockResolvedValue({ getLedPlacements: fakeFn });

    await loadGetLedPlacements(); // first call triggers import
    await loadGetLedPlacements(); // second call should use cache
    await loadGetLedPlacements(); // third call should use cache

    expect(mockImport).toHaveBeenCalledTimes(1);
  });

  it('returns the same function reference on every call', async () => {
    const fakeFn: GetLedPlacementsFn = () => ({ 10: 5 });
    mockImport.mockResolvedValue({ getLedPlacements: fakeFn });

    const fn1 = await loadGetLedPlacements();
    const fn2 = await loadGetLedPlacements();

    expect(fn1).toBe(fn2);
    expect(fn1).toBe(fakeFn);
  });

  it('correctly passes through arguments to the cached function', async () => {
    const fakeFn: GetLedPlacementsFn = vi.fn(() => ({ 5: 2, 8: 3 }));
    mockImport.mockResolvedValue({ getLedPlacements: fakeFn });

    const fn = await loadGetLedPlacements();
    const result = fn('kilter', 1, 10);

    expect(fakeFn).toHaveBeenCalledWith('kilter', 1, 10);
    expect(result).toEqual({ 5: 2, 8: 3 });
  });

  it('returns an empty object when the cached function returns one', async () => {
    const fakeFn: GetLedPlacementsFn = () => ({});
    mockImport.mockResolvedValue({ getLedPlacements: fakeFn });

    const fn = await loadGetLedPlacements();
    const result = fn('tension', 2, 5);

    expect(result).toEqual({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});
