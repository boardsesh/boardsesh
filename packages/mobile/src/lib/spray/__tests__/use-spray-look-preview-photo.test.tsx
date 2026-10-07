// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({
  ensure: vi.fn(async (_identity: unknown, _source: unknown) => '/cache/spray-walls/9-v3.jpg' as string | null),
}));
vi.mock('../spray-photo-cache', () => ({ ensureSprayPhotoCached: cache.ensure }));

const { useSprayLookPreviewPhoto } = await import('../use-spray-look-preview-photo');

const SOURCE = {
  layoutId: 9,
  versionId: 3,
  photoUrl: 'https://private.example/photo.jpg?sig=1',
  photoExpiresAt: 'later',
  photo: { width: 2400, height: 1800 },
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  frame: { width: 2400, height: 1800 },
  holds: [],
};

beforeEach(() => cache.ensure.mockClear());

describe('useSprayLookPreviewPhoto', () => {
  it('draws from the spray photo cache file, fetched with the payload signature', async () => {
    const { result } = renderHook(() => useSprayLookPreviewPhoto(SOURCE));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('file:///cache/spray-walls/9-v3.jpg'));
    expect(cache.ensure).toHaveBeenCalledExactlyOnceWith(
      { layoutId: 9, versionId: 3 },
      { url: SOURCE.photoUrl, expiresAt: 'later' },
    );
  });

  it('does not download again for a fresh signature on the same version', async () => {
    const { result, rerender } = renderHook(({ source }) => useSprayLookPreviewPhoto(source), {
      initialProps: { source: SOURCE },
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    rerender({ source: { ...SOURCE, photoUrl: 'https://private.example/photo.jpg?sig=2' } });
    expect(cache.ensure).toHaveBeenCalledOnce();
  });

  it('is null when the photo cannot be cached, and for no source', async () => {
    cache.ensure.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useSprayLookPreviewPhoto(SOURCE));
    await waitFor(() => expect(cache.ensure).toHaveBeenCalled());
    expect(result.current).toBeNull();
    expect(renderHook(() => useSprayLookPreviewPhoto(null)).result.current).toBeNull();
  });
});
