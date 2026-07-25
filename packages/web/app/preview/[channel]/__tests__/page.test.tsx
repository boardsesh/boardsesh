import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    locale: 'en-US',
  })),
}));

vi.mock('@/app/lib/i18n/get-locale', () => ({
  getLocale: vi.fn(async () => 'en-US'),
}));

vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: () => notFoundMock() }));

vi.mock('../preview-channel-content', () => ({
  default: (props: { channel: string; pullNumber: number }) => ({ type: 'PreviewChannelContent', props }),
}));

const pageModule = await import('../page');

describe('OTA preview page', () => {
  it('hands the parsed channel and PR number to the content component', async () => {
    const page = await pageModule.default({ params: Promise.resolve({ channel: 'pr-1234' }) });
    const content = (page as { props: { children: { props: unknown } } }).props.children;
    expect(content.props).toEqual({ channel: 'pr-1234', pullNumber: 1234 });
  });

  it('404s on anything that is not a published preview channel', async () => {
    // The channel comes off the URL and is echoed into a com.boardsesh.app://
    // link, so only the exact shape the preview workflow publishes gets a page.
    for (const channel of ['production', 'pr-', 'pr-12x', '../etc']) {
      await expect(pageModule.default({ params: Promise.resolve({ channel }) })).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });

  it('names the PR in the title and keeps the page out of the index', async () => {
    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ channel: 'pr-1234' }) });

    expect(metadata.title).toBe('Try PR #1234 in the app | Boardsesh');
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('emits no metadata for an invalid channel (the page 404s anyway)', async () => {
    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ channel: 'nope' }) });
    expect(metadata).toEqual({});
  });
});
