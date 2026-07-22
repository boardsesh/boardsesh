import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym } from '@boardsesh/shared-schema';
import GymDetail from '../gym-detail';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// The sheet is a portal-backed MUI drawer; render its children inline when open
// so the header markup is queryable without the transition/touch machinery.
vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
}));

// Heavy interactive children have their own hooks/subscriptions — stub them so
// this test stays focused on the header's new "view full page" link.
vi.mock('@/app/components/ui/follow-button', () => ({ default: () => <div data-testid="follow-button" /> }));
vi.mock('@/app/components/social/comment-section', () => ({ default: () => <div data-testid="comment-section" /> }));
vi.mock('../gym-member-management', () => ({ default: () => <div data-testid="member-management" /> }));
vi.mock('../claim-gym-dialog', () => ({ default: () => null }));
vi.mock('../report-duplicate-dialog', () => ({ default: () => null }));
vi.mock('../edit-gym-form', () => ({ default: () => null }));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'viewer-1' } }, status: 'authenticated' }),
}));

vi.mock('@/app/components/providers/feature-flags-provider', () => ({
  useFeatureFlag: () => false,
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'test-gym',
    ownerId: 'owner-1',
    ownerDisplayName: 'Owner',
    name: 'Test Gym',
    website: null,
    boardCount: 2,
    memberCount: 4,
    followerCount: 1,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    canClaim: false,
    ...overrides,
  } as unknown as Gym;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GymDetail header link', () => {
  it('links the gym name in the header to the public gym page', async () => {
    mockRequest.mockResolvedValue({ gym: makeGym() });
    render(<GymDetail gymUuid="gym-uuid-1" open onClose={vi.fn()} />);

    const link = await screen.findByRole('link', { name: 'Test Gym' });
    expect(link.getAttribute('href')).toBe('/gym/test-gym');
  });

  it('renders the name as plain text when the gym has no slug', async () => {
    mockRequest.mockResolvedValue({ gym: makeGym({ slug: null }) });
    render(<GymDetail gymUuid="gym-uuid-1" open onClose={vi.fn()} />);

    expect(await screen.findByText('Test Gym')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Test Gym' })).toBeNull();
  });
});
