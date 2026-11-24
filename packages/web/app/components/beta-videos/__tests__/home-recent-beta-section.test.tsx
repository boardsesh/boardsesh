import { afterEach, describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';

const mockRequest = vi.fn();
const boardseshBetaListSpy = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations/beta-links', () => ({
  GET_RECENT_BETA_LINKS: 'GET_RECENT_BETA_LINKS',
}));

vi.mock('@/app/lib/beta-video-url', () => ({
  mapBetaLinkRow: (row: { link: string; climbUuid: string }) =>
    ({
      link: row.link,
      climb_uuid: row.climbUuid,
      foreign_username: null,
      angle: null,
      thumbnail: 'https://example.com/beta.jpg',
      is_listed: false,
      created_at: '',
    }) as BetaLink,
}));

vi.mock('../boardsesh-beta-list', () => ({
  default: (props: {
    links: BetaLink[];
    isLoading: boolean;
    source: string;
    getClimbName?: (link: BetaLink) => string | null | undefined;
  }) => {
    boardseshBetaListSpy(props);
    return (
      <div data-testid="boardsesh-beta-list">
        {props.links.map((link) => (
          <div key={link.link} data-testid="beta-list-item">
            {link.link}::{props.getClimbName?.(link) ?? 'no-name'}
          </div>
        ))}
      </div>
    );
  },
}));

import HomeRecentBetaSection from '../home-recent-beta-section';

function makeRow(overrides: {
  link: string;
  climbUuid?: string;
  climbName?: string | null;
  layoutId?: number | null;
}): RecentBetaLinkRow {
  return {
    climbName: overrides.climbName ?? null,
    boardType: 'kilter',
    layoutId: overrides.layoutId ?? null,
    betaLink: {
      climbUuid: overrides.climbUuid ?? 'climb-uuid-1',
      link: overrides.link,
      foreignUsername: null,
      angle: null,
      thumbnail: 'https://example.com/beta.jpg',
      isListed: true,
      createdAt: null,
      tickUuid: null,
      boardId: null,
    },
  };
}

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  disconnect: () => void;
};
const observers: ObserverRecord[] = [];
class FakeIntersectionObserver {
  private readonly record: ObserverRecord;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, options, disconnect: vi.fn() };
    observers.push(this.record);
  }
  observe() {}
  disconnect() {
    this.record.disconnect();
  }
}

function renderSection() {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <HomeRecentBetaSection />
    </QueryClientProvider>,
  );
}

async function approachSection() {
  await act(async () => {
    observers[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

beforeEach(() => {
  mockRequest.mockReset().mockResolvedValue({ recentBetaLinks: [] });
  boardseshBetaListSpy.mockReset();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomeRecentBetaSection', () => {
  it('server-renders the heading and lead without beta rows or a query', () => {
    const html = renderToString(<HomeRecentBetaSection />);
    expect(html).toContain('home.recentBeta.title');
    expect(html).toContain('home.recentBeta.lead');
    expect(html).not.toContain('boardsesh-beta-list');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('does not fetch or mount cards until the section is within 400px', async () => {
    renderSection();
    expect(observers[0].options?.rootMargin).toBe('400px 0px');
    expect(screen.getByRole('heading', { name: 'home.recentBeta.title' })).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(boardseshBetaListSpy).not.toHaveBeenCalled();
    await act(async () => {
      observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(mockRequest).not.toHaveBeenCalled();
    await approachSection();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledOnce());
    expect(mockRequest).toHaveBeenCalledWith('GET_RECENT_BETA_LINKS', { limit: 20 });
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('fetches fresh rows without empty initialData and maps their climb labels', async () => {
    mockRequest.mockResolvedValue({
      recentBetaLinks: [
        makeRow({ link: 'https://instagram.com/p/aaa', climbUuid: 'c1', climbName: 'Cut to the Chase' }),
        makeRow({ link: 'https://www.tiktok.com/@u/video/123', climbUuid: 'c2', climbName: null }),
      ],
    });
    renderSection();
    await approachSection();
    expect(await screen.findByText('https://instagram.com/p/aaa::Cut to the Chase')).toBeTruthy();
    expect(screen.getByText('https://www.tiktok.com/@u/video/123::no-name')).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledOnce();
    expect(boardseshBetaListSpy.mock.lastCall?.[0]).toMatchObject({ source: 'home', isLoading: false });
  });

  it('keeps the public heading and reserved space when the query returns no videos', async () => {
    renderSection();
    await approachSection();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId('boardsesh-beta-list')).toBeNull());
    expect(screen.getByRole('heading', { name: 'home.recentBeta.title' })).toBeTruthy();
  });

  it('keeps the page usable when the beta query fails', async () => {
    mockRequest.mockRejectedValue(new Error('beta unavailable'));
    renderSection();
    await approachSection();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId('boardsesh-beta-list')).toBeNull());
    expect(screen.getByText('home.recentBeta.lead')).toBeTruthy();
  });

  it('loads after mount when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderSection();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledOnce());
  });
});
