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
    const manageLink = screen.getByRole('link', { name: 'Check your boards' });
    expect(manageLink.getAttribute('href')).toContain(`/gym/${GYM_UUID}/manage?tab=boards`);
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

describe('ClaimGymDialog — a refused claim', () => {
  it("says a gym its staff run can't be claimed in the viewer's words, and points at Report a problem", async () => {
    mockRequest.mockRejectedValueOnce({
      response: {
        errors: [
          {
            // The server's prose, which the dialog must not show: it's English only.
            message: 'Refused: staff-run listing',
            extensions: { code: 'GYM_RUN_BY_STAFF' },
          },
        ],
      },
    });

    renderDialog();
    await submit();

    await screen.findByText(tFromCatalog('boards', 'claimGym.errors.runByStaff'));
    expect(screen.queryByText('Refused: staff-run listing')).toBeNull();
  });

  it("keeps the server's message for any other refusal", async () => {
    mockRequest.mockRejectedValueOnce({
      response: { errors: [{ message: 'This gym is private and cannot be claimed' }] },
    });

    renderDialog();
    await submit();

    await screen.findByText('This gym is private and cannot be claimed');
  });
});

describe('ClaimGymDialog — which form opens', () => {
  const renderWith = (canClaimByDomain: boolean) =>
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ClaimGymDialog
          gymUuid={GYM_UUID}
          gymName="Bonsist"
          website="https://bonsist.com"
          canClaimByDomain={canClaimByDomain}
          open
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

  // A synced gym's website came from public data, not from whoever runs it, so
  // the server says no and the dialog must not open a form that can't succeed.
  it('opens admin review when the server says the website cannot prove a claim', () => {
    renderWith(false);
    expect(screen.getByText('Request review')).toBeTruthy();
    expect(screen.queryByLabelText('Work email')).toBeNull();
  });

  it('opens the work-email form when the server says it can', () => {
    renderWith(true);
    expect(screen.getByLabelText('Work email')).toBeTruthy();
  });
});
