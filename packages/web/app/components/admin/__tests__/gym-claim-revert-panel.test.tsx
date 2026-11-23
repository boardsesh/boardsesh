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

// The token the panel sees; a test swaps it and re-renders to play a refresh.
const auth = vi.hoisted(() => ({ token: 'admin-token' as string | null, clientTokens: [] as string[] }));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: auth.token }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: (token: string) => {
    auth.clientTokens.push(token);
    return { request: mockRequest };
  },
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
  auth.token = 'admin-token';
  auth.clientTokens = [];
});

/** How many times the panel looked up the digest link's claim. */
const linkLookups = () =>
  mockRequest.mock.calls.filter(
    ([document, variables]) => document === 'AUTO_APPROVED_GYM_CLAIMS' && variables?.input?.claimId,
  ).length;

/** How many times the panel asked for the first page of the list. */
const firstPageLoads = () =>
  mockRequest.mock.calls.filter(
    ([document, variables]) =>
      document === 'AUTO_APPROVED_GYM_CLAIMS' && !variables?.input?.claimId && (variables?.input?.offset ?? 0) === 0,
  ).length;

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

describe('GymClaimRevertPanel across an auth-token refresh', () => {
  /**
   * Swap the token and re-render, as the ws-auth refresh does every few
   * minutes. A fresh element each time: React skips re-rendering for the same one.
   */
  const refreshToken = (
    rerender: (ui: React.ReactElement) => void,
    ui: () => React.ReactElement,
    token = 'refreshed-token',
  ) => {
    auth.token = token;
    rerender(ui());
  };

  it("doesn't reopen a confirm the admin closed, or look the linked claim up again", async () => {
    answer({ listed: [], linked: claim });
    const ui = () => <GymClaimRevertPanel revertClaimId="42" />;
    const { rerender } = render(ui());

    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    refreshToken(rerender, ui);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(linkLookups()).toBe(1);
  });

  it('keeps a half-typed reason', async () => {
    answer({ listed: [], linked: claim });
    const ui = () => <GymClaimRevertPanel revertClaimId="42" />;
    const { rerender } = render(ui());

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Not their gym' } });
    refreshToken(rerender, ui);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((within(screen.getByRole('dialog')).getByLabelText('Reason (optional)') as HTMLTextAreaElement).value).toBe(
      'Not their gym',
    );
  });

  it('doesn\'t call a claim it just reverted "already reverted", and reverts with the fresh token', async () => {
    const rest = answer({ listed: [claim], linked: claim });
    rest.mockResolvedValue({
      revertGymClaim: { claimId: '42', gymUuid: claim.gymUuid, gymName: 'Synced Wall', removedMemberCount: 0 },
    });
    const ui = () => <GymClaimRevertPanel revertClaimId="42" />;
    const { rerender } = render(ui());

    const dialog = await screen.findByRole('dialog');
    refreshToken(rerender, ui);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revert claim' }));
    expect(await screen.findByText('Synced Wall is unclaimed again.')).toBeTruthy();
    expect(auth.clientTokens.at(-1)).toBe('refreshed-token');

    refreshToken(rerender, ui, 'refreshed-again');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Claim 42 was already reverted.')).toBeNull();
    expect(linkLookups()).toBe(1);
  });

  it('keeps the pages already loaded', async () => {
    const second = { ...claim, id: '41', gymName: 'Second Page Wall' };
    mockRequest.mockImplementation(async (_document: string, variables: { input?: { offset?: number } }) =>
      (variables.input?.offset ?? 0) === 0
        ? { autoApprovedGymClaims: { claims: [claim], totalCount: 2, hasMore: true } }
        : { autoApprovedGymClaims: { claims: [second], totalCount: 2, hasMore: false } },
    );
    const ui = () => <GymClaimRevertPanel />;
    const { rerender } = render(ui());

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Second Page Wall');

    refreshToken(rerender, ui);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('Synced Wall')).toBeTruthy();
    expect(screen.getByText('Second Page Wall')).toBeTruthy();
    expect(firstPageLoads()).toBe(1);
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
