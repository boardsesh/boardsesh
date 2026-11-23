import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GymClaim } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymClaimRevertPanel from '../gym-claim-revert-panel';
import { parseRevertParam, revertRefusal } from '../gym-claim-revert-logic';

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
  AUTO_APPROVED_GYM_CLAIMS: 'AUTO_APPROVED_GYM_CLAIMS',
  REVERT_GYM_CLAIM: 'REVERT_GYM_CLAIM',
}));

const claim: GymClaim = {
  id: '42',
  gymUuid: '6b1c1dd3-6e63-4f1e-9d0b-3e2ce4a0f5aa',
  gymName: 'Synced Wall',
  claimantUserId: 'user-1',
  claimantDisplayName: 'Ada',
  claimantAvatarUrl: null,
  method: 'admin',
  status: 'approved',
  claimEmail: null,
  message: null,
  createdAt: '2026-11-20T09:00:00.000Z',
  approvedAt: '2026-11-20T09:00:01.000Z',
  claimantAccountAgeDays: 40,
  claimantTickCount: 3,
  claimantGymsHeld: 1,
};

const list = (claims: GymClaim[]) => ({ autoApprovedGymClaims: { claims, totalCount: claims.length, hasMore: false } });

/** Answer the list and the digest lookup by what each asks for; everything else by `rest`. */
function answer({ listed = [claim], linked = null as GymClaim | null, rest = vi.fn() } = {}) {
  mockRequest.mockImplementation(async (document: string, variables: { input?: { claimId?: string } }) => {
    if (document === 'AUTO_APPROVED_GYM_CLAIMS') {
      return variables.input?.claimId ? list(linked ? [linked] : []) : list(listed);
    }
    return rest(document, variables);
  });
  return rest;
}

const refusal = (code: string) => Object.assign(new Error(code), { response: { errors: [{ extensions: { code } }] } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GymClaimRevertPanel', () => {
  it('lists claims that approved themselves, with Revert on the ones still approved', async () => {
    answer({ listed: [claim, { ...claim, id: '7', gymName: 'Old Wall', status: 'revoked' }] });
    render(<GymClaimRevertPanel />);

    await screen.findByText('Synced Wall');
    expect(screen.getByRole('button', { name: "Revert Ada's claim on Synced Wall" })).toBeTruthy();
    expect(screen.getByText('Reverted')).toBeTruthy();
  });

  it('reverts after a confirm that names the gym and the claimant, with the reason', async () => {
    const rest = answer();
    rest.mockResolvedValue({
      revertGymClaim: { claimId: '42', gymUuid: claim.gymUuid, gymName: 'Synced Wall', removedMemberCount: 1 },
    });
    render(<GymClaimRevertPanel />);

    fireEvent.click(await screen.findByRole('button', { name: "Revert Ada's claim on Synced Wall" }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("Revert Ada's claim on Synced Wall?")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Not their gym' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revert claim' }));

    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith('REVERT_GYM_CLAIM', { input: { claimId: '42', reason: 'Not their gym' } }),
    );
    expect(await screen.findByText('Synced Wall is unclaimed again.')).toBeTruthy();
    expect(screen.getByText('Reverted')).toBeTruthy();
  });

  it.each([
    ['GYM_CLAIM_REVERT_PRIOR_OWNER', 'This claim took the gym from a person, not from public board data.'],
    ['GYM_CLAIM_REVERT_OWNER_CHANGED', 'The gym changed hands after this claim. Use Move gym ownership below.'],
    ['GYM_CLAIM_REVERT_NOT_TRANSFERRED', 'This claim never moved the gym'],
  ])('keeps the confirm open on %s and points at Move gym ownership', async (code, text) => {
    const rest = answer();
    rest.mockRejectedValue(refusal(code));
    render(<GymClaimRevertPanel />);

    fireEvent.click(await screen.findByRole('button', { name: "Revert Ada's claim on Synced Wall" }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revert claim' }));

    expect(await screen.findByText(new RegExp(text.replace(/[.?]/g, '\\$&')))).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it("opens the digest link's claim straight into its confirm", async () => {
    answer({ listed: [], linked: { ...claim, gymName: 'Linked Wall' } });
    render(<GymClaimRevertPanel revertClaimId="42" />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("Revert Ada's claim on Linked Wall?")).toBeTruthy();
  });

  it('says so when the digest link names a claim already reverted, or one that is not an auto-approval', async () => {
    answer({ linked: { ...claim, status: 'revoked' } });
    const { unmount } = render(<GymClaimRevertPanel revertClaimId="42" />);
    expect(await screen.findByText('Claim 42 was already reverted.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    answer({ linked: null });
    render(<GymClaimRevertPanel revertClaimId="9" />);
    expect(await screen.findByText(/Claim 9 isn't one that approved itself/)).toBeTruthy();
  });
});

describe('gym claim revert logic', () => {
  it('reads only a positive whole claim id off the link', () => {
    expect(parseRevertParam('42')).toBe('42');
    expect(parseRevertParam(' 42 ')).toBe('42');
    expect(parseRevertParam('0')).toBeNull();
    expect(parseRevertParam('4e2')).toBeNull();
    expect(parseRevertParam(['42'])).toBeNull();
    expect(parseRevertParam(undefined)).toBeNull();
  });

  it('maps every refusal code, and anything else to a plain failure', () => {
    expect(revertRefusal(refusal('GYM_CLAIM_REVERT_NOT_FOUND'))).toBe('notFound');
    expect(revertRefusal(refusal('GYM_CLAIM_REVERT_NOT_APPROVED'))).toBe('notApproved');
    expect(revertRefusal(refusal('GYM_CLAIM_REVERT_NOT_TRANSFERRED'))).toBe('notTransferred');
    expect(revertRefusal(refusal('GYM_CLAIM_REVERT_OWNER_CHANGED'))).toBe('ownerChanged');
    expect(revertRefusal(refusal('GYM_CLAIM_REVERT_PRIOR_OWNER'))).toBe('priorOwner');
    expect(revertRefusal(refusal('RATE_LIMITED'))).toBe('failed');
    expect(revertRefusal(new Error('network'))).toBe('failed');
  });
});
