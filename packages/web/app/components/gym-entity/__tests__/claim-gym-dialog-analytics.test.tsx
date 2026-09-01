import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const mockRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const ClaimGymDialog = (await import('../claim-gym-dialog')).default;

const renderAdminDialog = (gymUuid = 'gym-uuid-1') =>
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ClaimGymDialog
        gymUuid={gymUuid}
        gymName="Bonsist"
        website={null}
        canClaimByDomain={false}
        open
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );

const submitAdminClaim = async () => {
  fireEvent.click(await screen.findByText('Request review'));
};

const eventsNamed = (name: string) =>
  trackGymFunnelEvent.mock.calls
    .map(([event]) => event as { name: string; properties: Record<string, unknown> })
    .filter((event) => event.name === name);

beforeEach(() => {
  mockRequest.mockReset();
  trackGymFunnelEvent.mockReset();
});

describe('ClaimGymDialog — submit event', () => {
  it('reports the admin path from what was actually sent', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'admin_review', email: null } });

    renderAdminDialog();
    await submitAdminClaim();

    await waitFor(() => expect(eventsNamed('Gym Claim Submitted')).toHaveLength(1));
    expect(eventsNamed('Gym Claim Submitted')[0].properties).toEqual({ method: 'admin', gymUuid: 'gym-uuid-1' });
  });

  it('reports the domain path when a claim email goes on the wire', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'email_sent', email: 'owner@bonsist.com' } });

    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ClaimGymDialog
          gymUuid="gym-uuid-domain"
          gymName="Bonsist"
          website="https://bonsist.com"
          canClaimByDomain
          open
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText('Work email'), { target: { value: 'owner@bonsist.com' } });
    fireEvent.click(screen.getByText('Send verification email'));

    await waitFor(() => expect(eventsNamed('Gym Claim Submitted')).toHaveLength(1));
    expect(eventsNamed('Gym Claim Submitted')[0].properties).toEqual({ method: 'domain', gymUuid: 'gym-uuid-domain' });
  });
});

describe('ClaimGymDialog — result event', () => {
  it('reports email_sent', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'email_sent', email: 'owner@bonsist.com' } });

    renderAdminDialog();
    await submitAdminClaim();

    await waitFor(() => expect(eventsNamed('Gym Claim Result')).toHaveLength(1));
    expect(eventsNamed('Gym Claim Result')[0].properties).toEqual({ status: 'email_sent', gymUuid: 'gym-uuid-1' });
  });

  it('reports approved', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'approved', email: null } });

    renderAdminDialog();
    await submitAdminClaim();

    await waitFor(() => expect(eventsNamed('Gym Claim Result')).toHaveLength(1));
    expect(eventsNamed('Gym Claim Result')[0].properties).toEqual({ status: 'approved', gymUuid: 'gym-uuid-1' });
  });

  it('reports admin_review — the backend spelling, not #4374’s admin_sent', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'admin_review', email: null } });

    renderAdminDialog();
    await submitAdminClaim();

    await waitFor(() => expect(eventsNamed('Gym Claim Result')).toHaveLength(1));
    expect(eventsNamed('Gym Claim Result')[0].properties).toEqual({ status: 'admin_review', gymUuid: 'gym-uuid-1' });
  });

  it('reports error when the mutation throws', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network down'));

    renderAdminDialog();
    await submitAdminClaim();

    await waitFor(() => expect(eventsNamed('Gym Claim Result')).toHaveLength(1));
    expect(eventsNamed('Gym Claim Result')[0].properties).toEqual({ status: 'error', gymUuid: 'gym-uuid-1' });
  });
});

describe('ClaimGymDialog — reuse across gyms', () => {
  it('reports the gym currently in props, not the one the dialog last showed', async () => {
    // One dialog instance is reused across gyms (see the re-init effect in the
    // component). Reading the uuid from state captured at mount would attribute
    // the second gym's claim to the first.
    mockRequest.mockResolvedValue({ requestGymClaim: { status: 'admin_review', email: null } });

    const { rerender } = render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ClaimGymDialog
          gymUuid="first-gym"
          gymName="First"
          website={null}
          canClaimByDomain={false}
          open
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await submitAdminClaim();
    await waitFor(() => expect(eventsNamed('Gym Claim Submitted')).toHaveLength(1));

    rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ClaimGymDialog
          gymUuid="second-gym"
          gymName="Second"
          website={null}
          canClaimByDomain={false}
          open={false}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ClaimGymDialog
          gymUuid="second-gym"
          gymName="Second"
          website={null}
          canClaimByDomain={false}
          open
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await submitAdminClaim();

    await waitFor(() => expect(eventsNamed('Gym Claim Submitted')).toHaveLength(2));
    expect(eventsNamed('Gym Claim Submitted').map((event) => event.properties.gymUuid)).toEqual([
      'first-gym',
      'second-gym',
    ]);
    expect(eventsNamed('Gym Claim Result').map((event) => event.properties.gymUuid)).toEqual([
      'first-gym',
      'second-gym',
    ]);
  });
});
