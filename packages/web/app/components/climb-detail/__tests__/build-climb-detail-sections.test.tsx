// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { renderHook, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBuildClimbDetailSections } from '../build-climb-detail-sections';
import type { Climb } from '@/app/lib/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock next/navigation. Tests can mutate `mockSearchParams` to vary the
// resolved query string per case.
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

// Mock child components to avoid pulling in their dependency trees
vi.mock('@/app/components/logbook/logbook-section', () => ({
  LogbookSection: () => null,
  useLogbookSummary: () => null,
}));
vi.mock('@/app/components/logbook/crew-logbook-view', () => ({
  CrewLogbookView: () => null,
}));
vi.mock('@/app/components/social/climb-social-section', () => ({
  default: () => null,
}));
vi.mock('@/app/components/charts/climb-analytics', () => ({
  default: () => null,
}));
vi.mock('@/app/components/beta-videos/boardsesh-beta-list', () => ({
  default: () => <div data-testid="beta-list" />,
}));
vi.mock('@/app/components/beta-videos/add-beta-video-dialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="beta-add-dialog" /> : null),
}));
// Render the add-button as a real <button> wired to its onClick prop so
// integration tests can drive the dialog via fireEvent.click rather than
// reaching into React element props.
vi.mock('@/app/components/beta-videos/boardsesh-beta-add-button', () => ({
  default: ({ onClick }: { onClick: () => void }) => (
    <button type="button" data-testid="beta-add-toggle" onClick={onClick}>
      toggle
    </button>
  ),
}));

// Mutable mock payload for the betaLinks GraphQL query.
let mockBetaLinks: Array<{
  climbUuid: string;
  link: string;
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean;
  createdAt: string;
}> = [];
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({
    request: async () => ({ betaLinks: mockBetaLinks }),
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MOCK_CLIMB = {
  uuid: 'test-climb-uuid',
  name: 'Test Climb',
  frames: 'p1r12',
  setter_username: 'tester',
  is_listed: true,
  is_draft: false,
  layout_id: 1,
  edge_left: 0,
  edge_right: 100,
  edge_bottom: 0,
  edge_top: 100,
  angle: 40,
  description: '',
  hsm: 0,
  difficulty: '5',
  quality_average: '3.0',
  stars: 3,
  stars_average: 3,
  difficulty_average: '5',
  difficulty_error: '0.00',
  benchmark_difficulty: null,
  ascensionist_count: 10,
  display_difficulty: 'V5',
  boulder_name: 'Test Climb',
  draft_difficulty: '5',
  repeat_count: 5,
  votes_count: 8,
  draft_difficulty_display: 'V5',
} as unknown as Climb;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const BASE_PROPS = {
  climb: MOCK_CLIMB,
  climbUuid: MOCK_CLIMB.uuid,
  boardType: 'kilter',
  angle: 40,
  layoutId: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useBuildClimbDetailSections', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSearchParams = new URLSearchParams();
    mockBetaLinks = [];
  });

  it('returns 6 sections when enabled (default)', () => {
    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    expect(result.current).toHaveLength(6);
    expect(result.current.map((s) => s.key)).toEqual([
      'beta',
      'logbook',
      'crew-logbook',
      'community',
      'analytics',
      'similar-climbs',
    ]);
  });

  it('returns empty array when enabled is false', () => {
    const { result } = renderHook(() => useBuildClimbDetailSections({ ...BASE_PROPS, enabled: false }), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns sections again when enabled flips from false to true', () => {
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBuildClimbDetailSections({ ...BASE_PROPS, enabled }),
      { wrapper, initialProps: { enabled: false } },
    );

    expect(result.current).toEqual([]);

    rerender({ enabled: true });

    expect(result.current).toHaveLength(6);
    expect(result.current.map((s) => s.key)).toEqual([
      'beta',
      'logbook',
      'crew-logbook',
      'community',
      'analytics',
      'similar-climbs',
    ]);
  });

  it('all sections are lazy', () => {
    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    for (const section of result.current) {
      expect(section.lazy).toBe(true);
    }
  });

  it('beta is the default-active section when no proposalUuid is set', () => {
    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    const beta = result.current.find((s) => s.key === 'beta');
    expect(beta?.defaultActive).toBe(true);
  });

  it('beta is NOT default-active when proposalUuid is set (community wins)', () => {
    mockSearchParams = new URLSearchParams('proposalUuid=abc');
    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    const beta = result.current.find((s) => s.key === 'beta');
    const community = result.current.find((s) => s.key === 'community');
    expect(beta?.defaultActive).toBe(false);
    expect(community?.defaultActive).toBe(true);
  });

  it('getSummary returns the deduped video count once betaLinks loads', async () => {
    mockBetaLinks = [
      {
        climbUuid: MOCK_CLIMB.uuid,
        link: 'https://www.instagram.com/reel/aaa/',
        foreignUsername: 'a',
        angle: 40,
        thumbnail: null,
        isListed: true,
        createdAt: '2024-01-01',
      },
      {
        climbUuid: MOCK_CLIMB.uuid,
        link: 'https://www.instagram.com/reel/bbb/',
        foreignUsername: 'b',
        angle: 40,
        thumbnail: null,
        isListed: true,
        createdAt: '2024-01-02',
      },
      {
        climbUuid: MOCK_CLIMB.uuid,
        link: 'https://www.tiktok.com/@user/video/123',
        foreignUsername: 'c',
        angle: 40,
        thumbnail: null,
        isListed: true,
        createdAt: '2024-01-03',
      },
    ];

    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const beta = result.current.find((s) => s.key === 'beta');
      expect(beta?.getSummary?.()).toEqual(['3 videos']);
    });
  });

  it('getSummary uses singular form for one video', async () => {
    mockBetaLinks = [
      {
        climbUuid: MOCK_CLIMB.uuid,
        link: 'https://www.instagram.com/reel/aaa/',
        foreignUsername: 'a',
        angle: 40,
        thumbnail: null,
        isListed: true,
        createdAt: '2024-01-01',
      },
    ];

    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const beta = result.current.find((s) => s.key === 'beta');
      expect(beta?.getSummary?.()).toEqual(['1 video']);
    });
  });

  it('beta content keeps the list visible and opens the add dialog from the action button', () => {
    const { result } = renderHook(() => useBuildClimbDetailSections(BASE_PROPS), {
      wrapper: createWrapper(),
    });

    const renderBeta = () => {
      const beta = result.current.find((s) => s.key === 'beta')!;
      return (
        <>
          {beta.action}
          {beta.content}
        </>
      );
    };

    const { rerender } = render(renderBeta());
    expect(screen.queryByTestId('beta-list')).not.toBeNull();
    expect(screen.queryByTestId('beta-add-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('beta-add-toggle'));
    rerender(renderBeta());
    expect(screen.queryByTestId('beta-list')).not.toBeNull();
    expect(screen.queryByTestId('beta-add-dialog')).not.toBeNull();
  });
});
