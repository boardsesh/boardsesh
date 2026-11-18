// @vitest-environment jsdom
// `useSearchGradeSourceSettled` gates the partner workout preview (#7824). A
// stored-preference read that throws must still settle it, on the upstream
// (Aurora) grade, or the card never builds its preview and Start stays off.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../../providers/feature-flags-provider', () => ({ useBoardseshGradeEnabled: () => true }));
vi.mock('../../../preference-store', () => ({
  getPreference: vi.fn(async () => {
    throw new Error('storage unavailable');
  }),
  setPreference: vi.fn(async () => undefined),
}));

import { useSearchGradeSourceActive, useSearchGradeSourceSettled } from '../search-grade-source';

describe('useSearchGradeSourceSettled', () => {
  it('settles on the upstream grade when the stored preference cannot be read', async () => {
    const { result } = renderHook(() => ({
      settled: useSearchGradeSourceSettled(),
      active: useSearchGradeSourceActive(),
    }));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.active).toBe(false);
  });
});
