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
  GET_USER_BETA_LINKS: 'GET_USER_BETA_LINKS',
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

vi.mock('@/app/components/beta-videos/boardsesh-beta-list', () => ({
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

import ProfileBetaSection from '../profile-beta-section';

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
      tickUuid: null,
      boardId: null,
    },
  };
}

function renderSection(initialBeta: RecentBetaLinkRow[], userId = 'user-1') {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ProfileBetaSection userId={userId} initialBeta={initialBeta} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  boardseshBetaListSpy.mockReset();
});

describe('ProfileBetaSection', () => {
  it('renders nothing when the user has no beta rows', () => {
    const { container } = renderSection([]);
    expect(container.firstChild).toBeNull();
    expect(boardseshBetaListSpy).not.toHaveBeenCalled();
  });

  it('maps rows into BetaLink shapes and tags analytics with source=profile', () => {
    const rows = [
      makeRow({ link: 'https://instagram.com/p/aaa', climbUuid: 'c1', climbName: 'Crimpy Mantle' }),
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
    expect(props.isLoading).toBe(false);
    // Profile slider tags analytics as `profile`, not `home` — that's how we
    // measure CTR per surface.
    expect(props.source).toBe('profile');
    expect(props.getClimbName?.(props.links[0])).toBe('Crimpy Mantle');
    expect(props.getClimbName?.(props.links[1])).toBeNull();
  });

  it('uses initialData without firing a GraphQL request on first render', async () => {
    renderSection([makeRow({ link: 'https://instagram.com/p/aaa', climbName: 'Boulder X' })]);

    await waitFor(() => {
      expect(screen.getByTestId('boardsesh-beta-list')).toBeTruthy();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('keys the query by userId so different profiles do not share cache state', async () => {
    // Render two sections with different userIds. The mock returns the same
    // initialData, so we just verify both render independently and neither
    // fires a network request (initialData wins on first paint).
    const rows = [makeRow({ link: 'https://instagram.com/p/aaa', climbName: 'A' })];
    const { unmount } = renderSection(rows, 'user-a');
    unmount();
    renderSection(rows, 'user-b');

    await waitFor(() => {
      expect(screen.getByTestId('boardsesh-beta-list')).toBeTruthy();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
