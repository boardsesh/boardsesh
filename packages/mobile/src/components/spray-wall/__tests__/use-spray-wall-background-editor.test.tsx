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
  renderData: null as unknown,
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => ({
    request: async (document: unknown) =>
      String(document).includes('sprayWallRenderData')
        ? { sprayWallRenderData: controls.renderData }
        : { sprayWall: { uuid: 'wall', renderSettings: controls.stored } },
  }),
}));
vi.mock('../../../lib/spray/use-spray-wall-art', () => ({ useSprayWallArt: () => controls.art }));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  useSetSprayWallRenderSettings: () => ({ mutateAsync: controls.save }),
}));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  requestMissingSprayArt: controls.requestArt,
  RENDER_DATA_STALE_TIME_MS: 600_000,
  sprayWallPublishedRenderDataQueryKey: (uuid: string, generation: number) => [
    'sprayWallRenderData',
    uuid,
    { viewerGeneration: generation },
  ],
}));

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
  controls.renderData = null;
});

describe('useSprayWallBackgroundEditor', () => {
  it('hands the picker the published photo, pins and holds for its tiles', async () => {
    controls.stored = LOOK;
    controls.renderData = {
      versionNumber: 2,
      boardWidth: 2000,
      boardHeight: 1500,
      homography: [1, 0, -100, 0, 1, -100, 0, 0, 1],
      photo: {
        url: 'https://private.example/photo.jpg',
        thumbUrl: null,
        width: 2400,
        height: 1800,
        expiresAt: 'later',
      },
      holds: [{ id: 1, cx: 400, cy: 400, r: 40, outline: null }],
      wall: { uuid: 'wall', currentVersion: { id: '3' } },
    };
    const { result } = await mounted();
    await waitFor(() =>
      expect(result.current.previewSource).toEqual({
        layoutId: 9,
        versionId: 3,
        photoUrl: 'https://private.example/photo.jpg',
        photoExpiresAt: 'later',
        photo: { width: 2400, height: 1800 },
        homography: [1, 0, -100, 0, 1, -100, 0, 0, 1],
        frame: { width: 2000, height: 1500 },
        holds: [{ cx: 400, cy: 400, r: 40, outline: null }],
      }),
    );
  });

  it('starts on the stored background and sends nothing when unchanged', async () => {
    controls.stored = { ...LOOK, background: 'wall-crop' };
    const { result } = await mounted();
    await waitFor(() => expect(result.current.value).toBe('wall-crop'));
    await act(async () => expect(await result.current.save()).toEqual({ outcome: 'unchanged' }));
    expect(controls.save).not.toHaveBeenCalled();
  });

  it('keeps the stored look and adds the picked background', async () => {
    controls.stored = LOOK;
    const { result } = await mounted();
    act(() => result.current.onChange('hold-cutouts'));
    await act(async () => expect(await result.current.save()).toEqual({ outcome: 'saved' }));
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
    await act(async () => expect(await result.current.save()).toEqual({ outcome: 'saved' }));
    expect(controls.save).toHaveBeenCalledWith(
      expect.objectContaining({ renderSettings: { ...LOOK, background: 'photo' } }),
    );
  });

  it('reports a server refusal without throwing', async () => {
    controls.stored = LOOK;
    controls.save.mockRejectedValueOnce({
      response: {
        errors: [{ message: 'no', extensions: { code: 'SPRAY_WALL_ART_NOT_AVAILABLE', reason: 'no-pins' } }],
      },
    });
    const { result } = await mounted();
    act(() => result.current.onChange('wall-crop'));
    await act(async () => expect(await result.current.save()).toEqual({ outcome: 'refused', reason: 'no-pins' }));
  });

  it('re-sends a stored look whose render failed, so Save retries it', async () => {
    controls.stored = { ...LOOK, background: 'wall-crop' };
    controls.art = { status: 'success', data: { ...GOOD, status: 'FAILED' } };
    const { result } = await mounted();
    await waitFor(() => expect(result.current.changed).toBe(true));
    await act(async () => expect(await result.current.save()).toEqual({ outcome: 'saved' }));
    expect(controls.save).toHaveBeenCalledWith(
      expect.objectContaining({ renderSettings: { ...LOOK, background: 'wall-crop' } }),
    );
  });
});
