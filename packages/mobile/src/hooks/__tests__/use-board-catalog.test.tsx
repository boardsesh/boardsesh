// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsBoardTypeVisible } from '../use-board-visibility';
import { useAvailableCatalogBoards, useBoardCatalogReadiness } from '../use-board-catalog';

const flags = vi.hoisted(() => ({ quantum: undefined as boolean | string | undefined }));
vi.mock('../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => (key === 'quantum-board' ? flags.quantum : undefined),
}));

beforeEach(() => {
  flags.quantum = true;
});

describe('fixed catalogue configuration boundary', () => {
  it.each([undefined, false, 'true'])('hides Quantum unless explicitly enabled (%s)', (flag) => {
    flags.quantum = flag;
    const { result } = renderHook(() => ({
      boards: useAvailableCatalogBoards(),
      ready: useBoardCatalogReadiness('quantum', 9101, 9201).geometryReady,
      visible: useIsBoardTypeVisible(),
    }));
    expect(result.current.boards).not.toContain('quantum');
    expect(result.current.boards).toContain('kilter');
    expect(result.current.ready).toBe(false);
    expect(result.current.visible('quantum')).toBe(false);
    expect(result.current.visible('spray')).toBe(true);
  });

  it('updates mounted discovery when the flag changes without changing other boards', () => {
    flags.quantum = undefined;
    const { result, rerender } = renderHook(() => useAvailableCatalogBoards());
    const otherBoards = result.current;
    flags.quantum = true;
    rerender();
    expect(result.current).toContain('quantum');
    expect(result.current.filter((board) => board !== 'quantum')).toEqual(otherBoards);
    flags.quantum = false;
    rerender();
    expect(result.current).toEqual(otherBoards);
  });

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
