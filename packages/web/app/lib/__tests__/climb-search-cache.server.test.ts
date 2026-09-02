// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { revalidateClimbSearchTags } from '../climb-search-cache.server';

vi.mock('server-only', () => ({}));

const mockRevalidateTag = vi.fn();
vi.mock('next/cache', () => ({
  revalidateTag: (...args: Parameters<typeof mockRevalidateTag>) => mockRevalidateTag(...args),
}));

describe('revalidateClimbSearchTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revalidates the board tag', async () => {
    await revalidateClimbSearchTags({ boardName: 'moonboard' });

    expect(mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith('climb-search:moonboard', { expire: 0 });
  });

  it('scopes the tag to the board it was given', async () => {
    await revalidateClimbSearchTags({ boardName: 'kilter' });

    expect(mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith('climb-search:kilter', { expire: 0 });
  });
});
