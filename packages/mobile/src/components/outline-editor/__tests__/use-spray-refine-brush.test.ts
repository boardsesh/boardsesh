// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  getPreference: vi.fn<(key: string) => Promise<unknown>>(),
  setPreference: vi.fn<(key: string, value: unknown) => Promise<void>>(),
}));
vi.mock('../../../lib/preference-store', () => store);

import { DEFAULT_REFINE_BRUSH_PT } from '../spray-refine';
import { SPRAY_REFINE_BRUSH_KEY, useSprayRefineBrush } from '../use-spray-refine-brush';

describe('useSprayRefineBrush', () => {
  beforeEach(() => {
    store.getPreference.mockReset();
    store.setPreference.mockReset();
    store.setPreference.mockResolvedValue(undefined);
  });

  it('starts on the default and reads the stored size back', async () => {
    store.getPreference.mockResolvedValue(8);
    const hook = renderHook(useSprayRefineBrush);
    expect(hook.result.current[0]).toBe(DEFAULT_REFINE_BRUSH_PT);
    await waitFor(() => expect(hook.result.current[0]).toBe(8));
    expect(store.getPreference).toHaveBeenCalledWith(SPRAY_REFINE_BRUSH_KEY);
  });

  it('saves a pick as picked, and a late read does not overwrite it', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    store.getPreference.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)));
    const hook = renderHook(useSprayRefineBrush);
    act(() => hook.result.current[1](4.1));
    expect(hook.result.current[0]).toBe(4.1);
    expect(store.setPreference).toHaveBeenCalledWith(SPRAY_REFINE_BRUSH_KEY, 4.1);
    await act(async () => resolveRead(16));
    expect(hook.result.current[0]).toBe(4.1);
  });
});
