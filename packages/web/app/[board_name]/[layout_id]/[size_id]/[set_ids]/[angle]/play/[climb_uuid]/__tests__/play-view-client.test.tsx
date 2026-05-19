import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import PlayViewClient from '../play-view-client';
import type { BoardDetails } from '@/app/lib/types';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

const mockPush = vi.fn();

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: mockPush, replace: vi.fn() }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/components/graphql-queue', () => ({
  useCurrentClimb: () => ({ currentClimb: null }),
  useQueueList: () => ({ queue: [] }),
  useQueueActions: () => ({
    setCurrentClimbQueueItem: vi.fn(),
    getNextClimbQueueItem: vi.fn(() => null),
    getPreviousClimbQueueItem: vi.fn(() => null),
  }),
}));

vi.mock('@/app/components/board-renderer/swipe-board-carousel', () => ({
  default: () => null,
}));

vi.mock('@/app/components/climb-card/climb-title', () => ({
  default: () => null,
}));

vi.mock('@/app/components/climb-card/ascent-status', () => ({
  AscentStatus: () => null,
}));

vi.mock('@/app/components/play-view/play-view-comments', () => ({
  default: () => null,
}));

vi.mock('@/app/components/ui/empty-state', () => ({
  EmptyState: ({ description }: { description: string }) => <div>{description}</div>,
}));

vi.mock('../play-view.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 2],
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Home',
  set_names: ['Bolt-On'],
} as unknown as BoardDetails;

describe('PlayViewClient getBackToListUrl (empty state)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('preserves live URL query string when navigating back to the list', () => {
    // QueueContext writes filter state to the URL via history.replaceState,
    // which Next.js's useSearchParams() does not observe. The play view must
    // read window.location.search directly so filters aren't dropped.
    window.history.replaceState({}, '', '/kilter/1/10/1,2/40/play/some-climb?minGrade=10&onlyClassics=true');

    render(<PlayViewClient boardDetails={boardDetails} initialClimb={null} angle={40} />);

    fireEvent.click(screen.getByRole('button', { name: /browse climbs/i }));

    const pushedUrl = mockPush.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('minGrade=10');
    expect(pushedUrl).toContain('onlyClassics=true');
  });

  it('does not append a trailing ? when no filters are set', () => {
    window.history.replaceState({}, '', '/kilter/1/10/1,2/40/play/some-climb');

    render(<PlayViewClient boardDetails={boardDetails} initialClimb={null} angle={40} />);

    fireEvent.click(screen.getByRole('button', { name: /browse climbs/i }));

    const pushedUrl = mockPush.mock.calls[0]?.[0] as string;
    expect(pushedUrl).not.toContain('?');
  });
});
