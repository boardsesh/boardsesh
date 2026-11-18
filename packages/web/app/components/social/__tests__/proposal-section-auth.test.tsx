import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import ProposalSection from '../proposal-section';

const auth = vi.hoisted(() => ({ token: 'account-a' as string | null }));
const request = vi.hoisted(() => vi.fn());
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: auth.token }) }));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: (token?: string) => ({ request: (query: string) => request(token, query) }),
}));
vi.mock('@boardsesh/graphql/operations/proposals', () => ({
  GET_CLIMB_COMMUNITY_STATUS: 'status',
  GET_CLIMB_PROPOSALS: 'proposals',
  GET_MY_ROLES: 'roles',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/components/collapsible-section/collapsible-section', () => ({
  default: ({ sections }: { sections: { key: string; content: React.ReactNode }[] }) =>
    sections.map((section) => <div key={section.key}>{section.content}</div>),
}));
vi.mock('../create-proposal-form', () => ({ default: () => <button>Create proposal</button> }));
vi.mock('../proposal-card', () => ({ default: () => null }));
vi.mock('../freeze-indicator', () => ({ default: () => null }));
vi.mock('../community-status-badge', () => ({ default: () => null }));
vi.mock('../freeze-climb-dialog', () => ({ default: () => <div role="dialog">Freeze dialog</div> }));
const props = { climbUuid: 'climb', boardType: 'kilter', angle: 40 };
beforeEach(() => {
  auth.token = 'account-a';
  request
    .mockReset()
    .mockImplementation(async (_token: string, query: string) =>
      query === 'status'
        ? { climbCommunityStatus: { isFrozen: false } }
        : query === 'proposals'
          ? { climbProposals: { proposals: [] } }
          : { myRoles: [{ role: 'admin', boardType: null }] },
    );
});
afterEach(cleanup);

describe('proposal moderation account ownership', () => {
  it('drops the freeze button and an open dialog when the token disappears', async () => {
    const view = render(<ProposalSection {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze climb' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    auth.token = null;
    view.rerender(<ProposalSection {...props} />);
    expect(screen.queryByRole('button', { name: 'Freeze climb' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a role response from the previous account', async () => {
    let finishOldRoles: ((response: { myRoles: { role: string; boardType: null }[] }) => void) | undefined;
    request.mockImplementation(async (token: string, query: string) => {
      if (query === 'status') return { climbCommunityStatus: { isFrozen: false } };
      if (query === 'proposals') return { climbProposals: { proposals: [] } };
      if (token === 'account-a')
        return new Promise((resolve) => {
          finishOldRoles = resolve;
        });
      return { myRoles: [] };
    });
    const view = render(<ProposalSection {...props} />);
    await waitFor(() => expect(finishOldRoles).toBeTypeOf('function'));
    auth.token = 'account-b';
    view.rerender(<ProposalSection {...props} />);
    await waitFor(() => expect(request).toHaveBeenCalledWith('account-b', 'roles'));
    await act(async () => finishOldRoles?.({ myRoles: [{ role: 'admin', boardType: null }] }));
    expect(screen.queryByRole('button', { name: 'Freeze climb' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
