import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
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
      thumbnail: null,
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
      thumbnail: null,
      isListed: true,
      createdAt: null,
      attachedByUser: null,
    },
  };
}

function renderSection(initialRecentBeta: RecentBetaLinkRow[]) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <HomeRecentBetaSection initialRecentBeta={initialRecentBeta} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  boardseshBetaListSpy.mockReset();
});

describe('HomeRecentBetaSection', () => {
  it('renders nothing when there are no beta rows', () => {
    const { container } = renderSection([]);
    expect(container.firstChild).toBeNull();
    expect(boardseshBetaListSpy).not.toHaveBeenCalled();
  });

  it('maps rows into BetaLink shapes and passes climbName via getClimbName', () => {
    const rows = [
      makeRow({ link: 'https://instagram.com/p/aaa', climbUuid: 'c1', climbName: 'Cut to the Chase' }),
      makeRow({ link: 'https://www.tiktok.com/@u/video/123', climbUuid: 'c2', climbName: null }),
    ];

    renderSection(rows);

    expect(boardseshBetaListSpy).toHaveBeenCalledTimes(1);
    const props = boardseshBetaListSpy.mock.calls[0][0] as {
      links: BetaLink[];
      isLoading: boolean;
      source: string;
      getClimbName?: (link: BetaLink) => string | null | undefined;
    };
    expect(props.links).toHaveLength(2);
    expect(props.links[0].link).toBe('https://instagram.com/p/aaa');
    expect(props.links[1].link).toBe('https://www.tiktok.com/@u/video/123');
    expect(props.isLoading).toBe(false);
    expect(props.source).toBe('home');
    expect(props.getClimbName?.(props.links[0])).toBe('Cut to the Chase');
    expect(props.getClimbName?.(props.links[1])).toBeNull();
    expect(props.getClimbName?.({ ...props.links[0], link: 'https://nope.example/x' })).toBeUndefined();
  });

  it('uses initialData without firing a GraphQL request on first render', async () => {
    renderSection([makeRow({ link: 'https://instagram.com/p/aaa', climbName: 'Boulder X' })]);

    // Wait one tick to make sure no background fetch sneaks in.
    await waitFor(() => {
      expect(screen.getByTestId('boardsesh-beta-list')).toBeTruthy();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
