// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS } from '@boardsesh/board-look';

const controls = vi.hoisted(() => ({
  stored: null as unknown,
  art: { status: 'success', data: null as unknown },
  save: vi.fn(async (_input: unknown) => ({})),
  requestArt: vi.fn(),
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: async () => ({ sprayWall: { uuid: 'wall', renderSettings: controls.stored } }) }),
}));
vi.mock('../../../lib/spray/use-spray-wall-art', () => ({ useSprayWallArt: () => controls.art }));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  useSetSprayWallRenderSettings: () => ({ mutateAsync: controls.save }),
}));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({ requestMissingSprayArt: controls.requestArt }));

const { useSprayWallBackgroundEditor } = await import('../use-spray-wall-background-editor');

const LOOK = { mode: 'aura', boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS };
const GOOD = {
  versionNumber: 2,
  recipe: 1,
  status: 'READY',
  quality: { stretch: 1.2, verdict: 'GOOD', reason: 'ok', frameShortEdge: 2000 },
};

function wrapper({ children }: { children?: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

async function mounted() {
  const hook = renderHook(() => useSprayWallBackgroundEditor({ wallUuid: 'wall', layoutId: 9, enabled: true }), {
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.gate.kind).toBe('open'));
  return hook;
}

beforeEach(() => {
  controls.save.mockClear();
  controls.requestArt.mockClear();
  controls.art = { status: 'success', data: GOOD };
});

describe('useSprayWallBackgroundEditor', () => {
  it('starts on the stored background and sends nothing when unchanged', async () => {
    controls.stored = { ...LOOK, background: 'wall-crop' };
    const { result } = await mounted();
    await waitFor(() => expect(result.current.value).toBe('wall-crop'));
    await act(async () => expect(await result.current.save()).toBe('unchanged'));
    expect(controls.save).not.toHaveBeenCalled();
  });

  it('keeps the stored look and adds the picked background', async () => {
    controls.stored = LOOK;
    const { result } = await mounted();
    act(() => result.current.onChange('hold-cutouts'));
    await act(async () => expect(await result.current.save()).toBe('saved'));
    expect(controls.save).toHaveBeenCalledWith({
      layoutId: 9,
      uuid: 'wall',
      renderSettings: { ...LOOK, background: 'hold-cutouts' },
    });
    expect(controls.requestArt).toHaveBeenCalledWith(9);
  });

  it('names the photo when leaving a generated look, since an omitted key keeps it', async () => {
    controls.stored = { ...LOOK, background: 'wall-crop' };
    const { result } = await mounted();
    await waitFor(() => expect(result.current.value).toBe('wall-crop'));
    act(() => result.current.onChange('photo'));
    await act(async () => expect(await result.current.save()).toBe('saved'));
    expect(controls.save).toHaveBeenCalledWith(
      expect.objectContaining({ renderSettings: { ...LOOK, background: 'photo' } }),
    );
  });

  it('reports a server refusal without throwing', async () => {
    controls.stored = LOOK;
    controls.save.mockRejectedValueOnce({
      response: { errors: [{ message: 'no', extensions: { code: 'SPRAY_WALL_ART_NOT_AVAILABLE' } }] },
    });
    const { result } = await mounted();
    act(() => result.current.onChange('wall-crop'));
    await act(async () => expect(await result.current.save()).toBe('refused'));
  });
});
