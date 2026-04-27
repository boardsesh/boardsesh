// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { revalidateClimbSearchTags } from '../climb-search-cache.server';

vi.mock('server-only', () => ({}));

const mockRevalidateTag = vi.fn();
vi.mock('next/cache', () => ({
  revalidateTag: (...args: Parameters<typeof mockRevalidateTag>) => mockRevalidateTag(...args),
}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics.server', () => ({
  track: (...args: Parameters<typeof mockTrack>) => mockTrack(...args),
}));

describe('revalidateClimbSearchTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockResolvedValue(undefined);
  });

  it('revalidates the board tag and emits a metric (layoutId is informational only)', async () => {
    const headers = new Headers({
      cookie: 'session=test',
      'user-agent': 'vitest',
      'x-forwarded-for': '127.0.0.1',
    });

    await revalidateClimbSearchTags({
      boardName: 'moonboard',
      layoutId: 3,
      requestHeaders: headers,
      source: 'internal-route',
    });

    expect(mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith('climb-search:moonboard', { expire: 0 });
    expect(mockTrack).toHaveBeenCalledWith(
      'Climb Search Cache Invalidated',
      {
        boardName: 'moonboard',
        layoutId: 3,
        source: 'internal-route',
      },
      { headers },
    );
  });

  it('revalidates only the board tag when no layout is provided', async () => {
    const headers = new Headers({
      'user-agent': 'vitest',
      'x-forwarded-for': '127.0.0.1',
    });

    await revalidateClimbSearchTags({
      boardName: 'kilter',
      requestHeaders: headers,
      source: 'save-climb-proxy',
    });

    expect(mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith('climb-search:kilter', { expire: 0 });
    expect(mockTrack).toHaveBeenCalledWith(
      'Climb Search Cache Invalidated',
      {
        boardName: 'kilter',
        layoutId: null,
        source: 'save-climb-proxy',
      },
      { headers },
    );
  });
});
