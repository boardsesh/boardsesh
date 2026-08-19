import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import ClaimGymDialog from '../claim-gym-dialog';

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

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const GYM_UUID = 'gym-uuid-1';

// No website, so the dialog opens straight into the admin-review mode — the only
// path that can come back `approved`.
const renderDialog = () =>
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ClaimGymDialog
        gymUuid={GYM_UUID}
        gymName="Bonsist"
        website={null}
        canClaimByDomain={false}
        open
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );

const submit = async () => {
  fireEvent.click(await screen.findByText('Request review'));
};

beforeEach(() => {
  mockRequest.mockReset();
  mockRefresh.mockReset();
});

describe('ClaimGymDialog — auto-approved claim', () => {
  it('confirms ownership and links to the manage page', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'approved', email: null } });

    renderDialog();
    await submit();

    await screen.findByText("Bonsist is yours. Set it up whenever you're ready.");

    // The CTA has to be a real link, not a click handler, so it is crawlable
    // and middle-clickable like the rest of the app's navigation.
    const manageLink = screen.getByRole('link', { name: 'Set up your gym' });
    expect(manageLink.getAttribute('href')).toContain(`/gym/${GYM_UUID}/manage`);
  });

  it('refreshes the server-rendered page so the claim CTA clears', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'approved', email: null } });

    renderDialog();
    await submit();

    // `canClaim` is computed server-side, so without this the page behind the
    // dialog keeps offering a claim the viewer has already won.
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('still shows the review message when the claim only queues', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'admin_review', email: null } });

    renderDialog();
    await submit();

    // The confirmation promises the outcome email the funnel now actually
    // sends, rather than narrating an admin notification that a claimant with a
    // backlog doesn't trigger.
    await screen.findByText("Your claim is in the review queue. We'll email you as soon as it's decided.");
    // Nothing was transferred, so there is nothing to refresh.
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

// A company-looking website is only half the rule: the gym's OWNER has to have
// put it there. The dialog used to read the first half off `website` alone, so
// an un-vouched listing opened the email form and the climber only heard "no"
// after typing their work address (#4018).
describe('ClaimGymDialog — which form opens comes from canClaimByDomain, not the website', () => {
  const renderWithCapability = (canClaimByDomain: boolean) =>
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ClaimGymDialog
          gymUuid={GYM_UUID}
          gymName="Bonsist"
          website="https://bonsist.bg"
          canClaimByDomain={canClaimByDomain}
          open
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

  it('opens admin review on an un-vouched gym, even though the website looks claimable', () => {
    renderWithCapability(false);

    // No jest-dom here, so assert on the queried node itself.
    expect(screen.queryByLabelText('Work email')).toBeNull();
    expect(screen.queryByText('Send verification email')).toBeNull();
    // …and no offer to switch to a path that would be refused.
    expect(screen.queryByText('Verify with a work email instead')).toBeNull();
    expect(screen.getByLabelText('Message (optional)')).not.toBeNull();
  });

  it('sends an admin-review claim with no claimEmail from that state', async () => {
    mockRequest.mockResolvedValueOnce({ requestGymClaim: { status: 'admin_review', email: null } });

    renderWithCapability(false);
    fireEvent.click(await screen.findByText('Request review'));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    const [, variables] = mockRequest.mock.calls[0] as [unknown, { input: Record<string, unknown> }];
    expect(variables.input.gymUuid).toBe(GYM_UUID);
    expect('claimEmail' in variables.input).toBe(false);
  });

  it('opens the email form on the same website once it is owner-vouched', async () => {
    renderWithCapability(true);

    expect(await screen.findByLabelText('Work email')).not.toBeNull();
    expect(screen.queryByText('Send verification email')).not.toBeNull();
  });
});
