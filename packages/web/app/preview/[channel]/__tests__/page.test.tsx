import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const navigationMocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  }),
}));

vi.mock('next/navigation', () => navigationMocks);

const pageModule = await import('../page');

describe('legacy OTA preview page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends an old preview-comment link to its pull request', async () => {
    await expect(pageModule.default({ params: Promise.resolve({ channel: 'pr-1234' }) })).rejects.toThrow(
      'NEXT_REDIRECT:https://github.com/boardsesh/boardsesh/pull/1234',
    );
  });

  it.each(['production', 'pr-0', 'pr-01', 'pr-', 'pr-12x', '../etc', `pr-${Number.MAX_SAFE_INTEGER}0`])(
    '404s for invalid legacy branch %s',
    async (channel) => {
      await expect(pageModule.default({ params: Promise.resolve({ channel }) })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(navigationMocks.redirect).not.toHaveBeenCalled();
    },
  );
});
