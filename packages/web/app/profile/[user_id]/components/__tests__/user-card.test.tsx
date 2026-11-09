import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { UserProfile } from '../../utils/profile-constants';
import UserCard, { type UserCardProps } from '../user-card';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock dependencies before component import
vi.mock('@/app/components/ui/follow-button', () => ({
  default: (props: { entityId: string }) => <div data-testid="follow-button">{props.entityId}</div>,
}));

vi.mock('@/app/components/social/follower-count', () => ({
  default: (props: { userId: string; followerCount: number; followingCount: number }) => (
    <div data-testid="follower-count">
      {props.followerCount} followers, {props.followingCount} following
    </div>
  ),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FOLLOW_USER: 'FOLLOW_USER',
  UNFOLLOW_USER: 'UNFOLLOW_USER',
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    transitions: { normal: '200ms ease' },
    shadows: { md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' },
  },
}));

function createDefaultProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'user-123',
    email: 'test@example.com',
    displayName: 'Display Name',
    avatarUrl: 'https://example.com/profile-avatar.jpg',
    instagramUrl: null,
    followerCount: 10,
    followingCount: 5,
    isFollowedByMe: false,
    ...overrides,
  };
}

function createDefaultProps(overrides: Partial<UserCardProps> = {}): UserCardProps {
  return {
    userId: 'user-123',
    profile: createDefaultProfile(),
    isOwnProfile: false,
    onProfileUpdate: vi.fn(),
    ...overrides,
  };
}

describe('UserCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the display name', () => {
    render(<UserCard {...createDefaultProps()} />);
    expect(screen.getByText('Display Name')).toBeTruthy();
  });

  // The backend already coalesces displayName onto the NextAuth users.name, so
  // a null here means the account genuinely has neither.
  it("falls back to 'Climber' when there is no display name", () => {
    const props = createDefaultProps({
      profile: createDefaultProfile({ displayName: null, avatarUrl: null }),
    });
    render(<UserCard {...props} />);
    expect(screen.getByText('Climber')).toBeTruthy();
  });

  it('renders avatar with correct src', () => {
    render(<UserCard {...createDefaultProps()} />);
    const avatar = screen.getByRole('img');
    expect(avatar.getAttribute('src')).toBe('https://example.com/profile-avatar.jpg');
  });

  it('shows follow button when not own profile', () => {
    render(<UserCard {...createDefaultProps({ isOwnProfile: false })} />);
    expect(screen.getByTestId('follow-button')).toBeTruthy();
  });

  it('hides follow button on own profile', () => {
    render(<UserCard {...createDefaultProps({ isOwnProfile: true })} />);
    expect(screen.queryByTestId('follow-button')).toBeNull();
  });

  it('shows email on own profile', () => {
    render(<UserCard {...createDefaultProps({ isOwnProfile: true })} />);
    expect(screen.getByText('test@example.com')).toBeTruthy();
  });

  it('hides email when not own profile', () => {
    render(<UserCard {...createDefaultProps({ isOwnProfile: false })} />);
    expect(screen.queryByText('test@example.com')).toBeNull();
  });

  it('renders follower count', () => {
    render(<UserCard {...createDefaultProps()} />);
    const followerCount = screen.getByTestId('follower-count');
    expect(followerCount.textContent).toContain('10 followers');
    expect(followerCount.textContent).toContain('5 following');
  });

  it('renders Instagram link when available', () => {
    const props = createDefaultProps({
      profile: createDefaultProfile({
        displayName: 'Test',
        avatarUrl: null,
        instagramUrl: 'https://instagram.com/climber',
      }),
    });
    render(<UserCard {...props} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://instagram.com/climber');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does not render Instagram link when not available', () => {
    render(<UserCard {...createDefaultProps()} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
