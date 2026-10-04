import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GymClaim } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymClaimsPanel from '../gym-claims-panel';

const mockRequest = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'admin-token' }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  PENDING_GYM_CLAIMS: 'PENDING_GYM_CLAIMS',
  REVIEW_GYM_CLAIM: 'REVIEW_GYM_CLAIM',
}));

const claim: GymClaim = {
  id: '17',
  gymUuid: '6b1c1dd3-6e63-4f1e-9d0b-3e2ce4a0f5aa',
  gymName: 'Committee Wall',
  claimantUserId: 'stale-claimant',
  claimantDisplayName: 'Ada Claimant',
  claimantAvatarUrl: null,
  method: 'admin',
  status: 'pending',
  claimEmail: null,
  message: 'I run this place.',
  createdAt: '2026-07-01T09:00:00.000Z',
};

function queueResponse() {
  return { pendingGymClaims: { claims: [claim], totalCount: 1, hasMore: false } };
}

async function renderQueue(): Promise<void> {
  render(<GymClaimsPanel />);
  await screen.findByText('Committee Wall');
}

describe('GymClaimsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the superseded rejection and keeps the claim in the queue for a Deny', async () => {
    const superseded = Object.assign(new Error('superseded'), {
      response: { errors: [{ extensions: { code: 'GYM_CLAIM_SUPERSEDED' } }] },
    });
    mockRequest.mockResolvedValueOnce(queueResponse()).mockRejectedValueOnce(superseded);

    await renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // The code-specific line, not the generic "couldn't update": approving is
    // never going to work on this row, and the reviewer needs to know why.
    expect(
      await screen.findByText(
        'This gym changed hands after the claim was filed. Deny it, or use Move gym ownership below.',
      ),
    ).toBeTruthy();

    // The claim is still pending server-side, and Deny is the next action — so
    // it must not disappear from the table the way a successful review does.
    expect(screen.getByText('Committee Wall')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(false);
  });

  it('falls back to the generic failure line when a rejection carries no code', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse()).mockRejectedValueOnce(new Error('network down'));

    await renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText("Couldn't update the claim")).toBeTruthy();
    expect(screen.getByText('Committee Wall')).toBeTruthy();
  });

  it('drops the row from the queue when the review lands', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse()).mockResolvedValueOnce({ reviewGymClaim: true });

    await renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Claim approved — ownership transferred')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Committee Wall')).toBeNull());
  });
});
