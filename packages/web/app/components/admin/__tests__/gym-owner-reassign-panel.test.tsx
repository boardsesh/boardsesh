import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GymOwnershipSummary, GymOwnershipUserSummary } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymOwnerReassignPanel from '../gym-owner-reassign-panel';

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
  GYM_OWNERSHIP_LOOKUP: 'GYM_OWNERSHIP_LOOKUP',
  REASSIGN_GYM_OWNER: 'REASSIGN_GYM_OWNER',
}));

const gym: GymOwnershipSummary = {
  gymUuid: '6b1c1dd3-6e63-4f1e-9d0b-3e2ce4a0f5aa',
  slug: 'committee-wall',
  name: 'Committee Wall',
  currentOwnerId: 'outgoing-owner',
  currentOwnerLabel: 'Dana Outgoing',
  currentOwnerIsSystem: false,
  syncFrozenAt: '2026-08-01T01:02:03.000Z',
  isDeleted: false,
  isMerged: false,
};

const newOwner: GymOwnershipUserSummary = {
  userId: 'incoming-owner',
  label: 'Rafa Incoming',
  email: 'rafa@example.com',
};

function lookupResponse(
  overrides: Partial<{ gym: GymOwnershipSummary | null; newOwner: GymOwnershipUserSummary | null }> = {},
) {
  return {
    gymOwnershipLookup: {
      gym: overrides.gym === undefined ? gym : overrides.gym,
      newOwner: overrides.newOwner === undefined ? newOwner : overrides.newOwner,
    },
  };
}

async function lookUp(): Promise<void> {
  render(<GymOwnerReassignPanel />);
  fireEvent.change(screen.getByLabelText('Gym'), { target: { value: gym.gymUuid } });
  fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'rafa@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  await screen.findByText('Committee Wall');
}

describe('GymOwnerReassignPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names both owners in the confirm step and fires no mutation until it is confirmed', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse()).mockResolvedValueOnce({
      reassignGymOwner: {
        gymUuid: gym.gymUuid,
        gymName: gym.name,
        previousOwnerId: gym.currentOwnerId,
        newOwnerId: newOwner.userId,
        syncFrozenAt: gym.syncFrozenAt,
      },
    });

    await lookUp();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('GYM_OWNERSHIP_LOOKUP', {
      input: { gymQuery: gym.gymUuid, newOwnerQuery: 'rafa@example.com' },
    });
    expect(screen.getByText('Owned by Dana Outgoing')).toBeTruthy();
    expect(screen.getByText('Rafa Incoming')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Move ownership' }));

    // The confirm step names the outgoing AND the incoming owner...
    expect(
      screen.getByText(
        'Committee Wall moves from Dana Outgoing to Rafa Incoming. The outgoing owner keeps gym-admin access; the new owner gets full control.',
      ),
    ).toBeTruthy();
    // ...and opening it sends nothing: still just the lookup.
    expect(mockRequest).toHaveBeenCalledTimes(1);

    const reasonInput = screen.getByLabelText('Reason');
    fireEvent.change(reasonInput, { target: { value: 'short' } });
    expect(screen.getAllByRole('button', { name: 'Move ownership' }).at(-1)?.hasAttribute('disabled')).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);

    fireEvent.change(reasonInput, { target: { value: '  The club elected a new chair.  ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Move ownership' }).at(-1)!);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('REASSIGN_GYM_OWNER', {
        input: {
          gymUuid: gym.gymUuid,
          expectedCurrentOwnerId: gym.currentOwnerId,
          newOwnerId: newOwner.userId,
          reason: 'The club elected a new chair.',
        },
      });
    });
    expect(await screen.findByText('Committee Wall moved to its new owner')).toBeTruthy();
  });

  it('blocks the handover for a merged listing and for an account that already owns the gym', async () => {
    mockRequest
      .mockResolvedValueOnce(lookupResponse({ gym: { ...gym, isMerged: true } }))
      .mockResolvedValueOnce(
        lookupResponse({ newOwner: { ...newOwner, userId: gym.currentOwnerId, label: 'Dana Outgoing' } }),
      );

    await lookUp();
    expect(
      screen.getByText('This listing was merged into another gym. Move the surviving listing instead.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move ownership' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('That account already owns this gym.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move ownership' }).hasAttribute('disabled')).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('reports an unmatched gym or account instead of offering a handover', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse({ gym: null, newOwner: null }));

    render(<GymOwnerReassignPanel />);
    fireEvent.change(screen.getByLabelText('Gym'), { target: { value: 'nowhere' } });
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('No gym matched that search.')).toBeTruthy();
    expect(screen.getByText('No account matched that email or id.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move ownership' }).hasAttribute('disabled')).toBe(true);
  });
});
