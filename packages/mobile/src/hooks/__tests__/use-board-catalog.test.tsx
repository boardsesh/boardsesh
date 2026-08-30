// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAvailableCatalogBoards, useBoardCatalogReadiness } from '../use-board-catalog';

describe('fixed catalogue configuration boundary', () => {
  it('offers all bundled boards immediately and excludes personal walls', () => {
    const { result } = renderHook(() => useAvailableCatalogBoards());
    expect(result.current).toContain('kilter');
    expect(result.current).toContain('woods');
    expect(result.current.filter((boardName) => boardName === 'quantum')).toHaveLength(1);
    expect(result.current).not.toContain('spray');
  });
  it('keeps the selected bundled family visible without duplicate entries', () => {
    const { result } = renderHook(() => useAvailableCatalogBoards());
    expect(result.current.filter((boardName) => boardName === 'quantum')).toHaveLength(1);
  });
  it('accepts each fixed standard size but rejects a different physical family', () => {
    const { result, rerender } = renderHook(
      ({ layoutId, sizeId }) => useBoardCatalogReadiness('quantum', layoutId, sizeId),
      {
        initialProps: { layoutId: 9101, sizeId: 9201 },
      },
    );
    expect(result.current).toEqual({ geometryReady: true });
    rerender({ layoutId: 9101, sizeId: 9202 });
    expect(result.current.geometryReady).toBe(true);
    rerender({ layoutId: 9104, sizeId: 9201 });
    expect(result.current.geometryReady).toBe(false);
    const bundled = renderHook(() => useBoardCatalogReadiness('kilter', 1, 1));
    expect(bundled.result.current).toEqual({ geometryReady: true });
  });
});
