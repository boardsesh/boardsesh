import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'viewer-1' } }, status: 'authenticated' }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FOLLOW_GYM: 'FOLLOW_GYM',
  UNFOLLOW_GYM: 'UNFOLLOW_GYM',
}));

const mockRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent,
  viewerStateFromSessionStatus: (status: string) => (status === 'authenticated' ? 'signed-in' : 'signed-out'),
}));

const GymFollowButton = (await import('../gym-follow-button')).default;

beforeEach(() => {
  mockRequest.mockReset();
  trackGymFunnelEvent.mockReset();
});

describe('GymFollowButton analytics', () => {
  it('reports one follow CTA click per accepted tap', async () => {
    mockRequest.mockResolvedValue({});

    render(<GymFollowButton gymUuid="gym-1" ownerId="someone-else" isFollowedByMe={false} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Page CTA Clicked',
      properties: { cta: 'follow', gymUuid: 'gym-1' },
    });
  });

  it('emits no phantom event when the mutation fails and the toggle rolls back', async () => {
    // The optimistic path calls onFollowChange twice on failure — once forward,
    // once back. Instrumenting through it would report an unfollow the climber
    // never asked for; onToggleClick fires once, at the click.
    mockRequest.mockRejectedValue(new Error('network down'));

    render(<GymFollowButton gymUuid="gym-1" ownerId="someone-else" isFollowedByMe={false} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for the gym owner, who never sees the button', () => {
    const { container } = render(<GymFollowButton gymUuid="gym-1" ownerId="viewer-1" isFollowedByMe={false} />);

    expect(container.innerHTML).toBe('');
    expect(trackGymFunnelEvent).not.toHaveBeenCalled();
  });
});
