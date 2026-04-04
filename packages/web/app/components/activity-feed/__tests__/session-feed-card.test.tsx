import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { SessionFeedItem } from '@boardsesh/shared-schema';

// Mock dependencies
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: (props: { ariaLabel?: string }) => (
    <div data-testid="css-bar-chart" aria-label={props.ariaLabel} />
  ),
}));

vi.mock('@/app/components/charts/session-grade-bars', () => ({
  buildSessionGradeBars: () => [],
}));

vi.mock('@/app/components/charts/outcome-doughnut', () => ({
  default: () => <div data-testid="outcome-doughnut" />,
}));

vi.mock('@/app/components/social/vote-button', () => ({
  default: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="vote-button" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));

const mockFeedCommentButton = vi.fn();
vi.mock('@/app/components/social/feed-comment-button', () => ({
  default: (props: { entityType: string; entityId: string; commentCount?: number }) => {
    mockFeedCommentButton(props);
    return (
      <div
        data-testid="feed-comment-button"
        data-entity-type={props.entityType}
        data-entity-id={props.entityId}
        data-comment-count={props.commentCount ?? 0}
      />
    );
  },
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    transitions: { normal: '200ms ease' },
    shadows: { md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' },
    borderRadius: { full: 9999, sm: 4 },
    colors: { amber: '#FBBF24', success: '#6B9080', successBg: '#EFF5F2' },
    typography: { fontSize: { xs: 12 } },
    neutral: { 300: '#D1D5DB' },
  },
}));

vi.mock('@/app/lib/grade-colors', () => ({
  getGradeColor: () => '#F44336',
  getGradeTextColor: () => '#FFFFFF',
  formatVGrade: (g: string | null | undefined) => g ?? null,
}));

import SessionFeedCard from '../session-feed-card';

function makeSession(overrides: Partial<SessionFeedItem> = {}): SessionFeedItem {
  return {
    sessionId: 'session-1',
    sessionType: 'inferred',
    sessionName: null,
    ownerUserId: 'user-1',
    participants: [{
      userId: 'user-1',
      displayName: 'Test User',
      avatarUrl: null,
      sends: 5,
      flashes: 2,
      attempts: 3,
    }],
    totalSends: 5,
    totalFlashes: 2,
    totalAttempts: 3,
    tickCount: 8,
    gradeDistribution: [{ grade: 'V5', flash: 2, send: 3, attempt: 3 }],
    boardTypes: ['kilter'],
    hardestGrade: 'V5',
    firstTickAt: '2024-01-15T10:00:00.000Z',
    lastTickAt: '2024-01-15T12:00:00.000Z',
    durationMinutes: 120,
    goal: null,
    upvotes: 5,
    downvotes: 1,
    voteScore: 4,
    commentCount: 2,
    ...overrides,
  };
}

describe('SessionFeedCard', () => {
  it('renders session data', () => {
    render(<SessionFeedCard session={makeSession()} />);

    expect(screen.getByTestId('activity-feed-item')).toBeTruthy();
    expect(screen.getByText('Test User')).toBeTruthy();
    expect(screen.getByText('5 sends')).toBeTruthy();
    expect(screen.getByText('2 flashes')).toBeTruthy();
    expect(screen.getByText('3 attempts')).toBeTruthy();
  });

  it('shows single user header for inferred sessions', () => {
    render(<SessionFeedCard session={makeSession()} />);

    // Should not show AvatarGroup (no multiple avatars)
    expect(screen.getByText('Test User')).toBeTruthy();
  });

  it('shows multiple participants for party mode sessions', () => {
    const session = makeSession({
      sessionType: 'party',
      participants: [
        { userId: 'u1', displayName: 'User One', avatarUrl: null, sends: 3, flashes: 1, attempts: 1 },
        { userId: 'u2', displayName: 'User Two', avatarUrl: null, sends: 2, flashes: 1, attempts: 2 },
      ],
    });

    render(<SessionFeedCard session={session} />);
    expect(screen.getByText('User One, User Two')).toBeTruthy();
  });

  it('links to session detail page and user profiles', () => {
    render(<SessionFeedCard session={makeSession()} />);

    const links = screen.getAllByRole('link');
    const hrefs = links.map((link) => link.getAttribute('href'));

    // Should have links to profile (avatar + name) and session detail (body)
    expect(hrefs).toContain('/crusher/user-1');
    expect(hrefs).toContain('/session/session-1');
  });

  it('avatar links to user profile', () => {
    render(<SessionFeedCard session={makeSession()} />);

    const links = screen.getAllByRole('link');
    const profileLinks = links.filter((link) => link.getAttribute('href') === '/crusher/user-1');
    expect(profileLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('renders VoteButton with session entity type', () => {
    render(<SessionFeedCard session={makeSession()} />);

    const voteButton = screen.getByTestId('vote-button');
    expect(voteButton.getAttribute('data-entity-type')).toBe('session');
    expect(voteButton.getAttribute('data-entity-id')).toBe('session-1');
  });

  it('renders FeedCommentButton with session entity type and id', () => {
    render(<SessionFeedCard session={makeSession()} />);

    const commentButton = screen.getByTestId('feed-comment-button');
    expect(commentButton.getAttribute('data-entity-type')).toBe('session');
    expect(commentButton.getAttribute('data-entity-id')).toBe('session-1');
  });

  it('passes comment count to FeedCommentButton', () => {
    render(<SessionFeedCard session={makeSession({ commentCount: 5 })} />);

    const commentButton = screen.getByTestId('feed-comment-button');
    expect(commentButton.getAttribute('data-comment-count')).toBe('5');
  });

  it('passes zero comment count to FeedCommentButton when no comments', () => {
    render(<SessionFeedCard session={makeSession({ commentCount: 0 })} />);

    const commentButton = screen.getByTestId('feed-comment-button');
    expect(commentButton.getAttribute('data-comment-count')).toBe('0');
  });

  it('handles empty grade distribution gracefully', () => {
    render(<SessionFeedCard session={makeSession({ gradeDistribution: [] })} />);
    expect(screen.queryByTestId('css-bar-chart')).toBeNull();
  });

  it('formats duration as minutes when under 60', () => {
    render(<SessionFeedCard session={makeSession({ durationMinutes: 45 })} />);
    expect(screen.getByText('45min')).toBeTruthy();
  });

  it('formats duration as hours and minutes when >= 60', () => {
    render(<SessionFeedCard session={makeSession({ durationMinutes: 120 })} />);
    expect(screen.getByText('2h')).toBeTruthy();
  });

  it('shows board types as text', () => {
    render(<SessionFeedCard session={makeSession({ boardTypes: ['kilter', 'tension'] })} />);
    expect(screen.getByText('Kilter, Tension')).toBeTruthy();
  });

  it('shows session name when available', () => {
    render(<SessionFeedCard session={makeSession({ sessionName: 'Evening Session' })} />);
    expect(screen.getByText('Evening Session')).toBeTruthy();
  });

  it('shows goal when available', () => {
    render(<SessionFeedCard session={makeSession({ goal: 'Send V7' })} />);
    expect(screen.getByText('Send V7')).toBeTruthy();
  });

  it('generates session name from day and board type when no name provided', () => {
    // 2024-01-15 is a Monday
    render(<SessionFeedCard session={makeSession({ sessionName: null, boardTypes: ['kilter'] })} />);
    expect(screen.getByText('Monday Kilter Session')).toBeTruthy();
  });
});
