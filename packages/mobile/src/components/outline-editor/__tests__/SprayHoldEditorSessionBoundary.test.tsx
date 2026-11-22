// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORED_USER_ID_QUERY_KEY } from '../../../hooks/use-current-user-id';
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
const credentials = vi.hoisted(() => ({ readLocalUserId: vi.fn() }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../lib/local-user-id', () => ({ readLocalUserId: credentials.readLocalUserId }));
import { SprayHoldEditorSessionBoundary } from '../SprayHoldEditorSessionBoundary';

function Probe({ owner }: { owner: string | null }) {
  const [mountedFor] = useState(owner);
  return <span data-testid="session">{`${owner ?? 'none'}:${mountedFor ?? 'none'}`}</span>;
}
function Boundary() {
  return (
    <SprayHoldEditorSessionBoundary wallUuid="wall" versionId="17">
      {(owner) => <Probe owner={owner} />}
    </SprayHoldEditorSessionBoundary>
  );
}
beforeEach(() => {
  auth.isAuthenticated = true;
  credentials.readLocalUserId.mockReset().mockResolvedValue('restored-setter');
});
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

describe('hold recovery account boundary', () => {
  it('resolves a cold authenticated session from stored credentials without fresh-login metadata', async () => {
    const { wrapper } = provider();
    render(<Boundary />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('session').textContent).toBe('restored-setter:restored-setter'));
  });
  it('remounts editing state when the local account changes', async () => {
    const { wrapper, client } = provider();
    render(<Boundary />, { wrapper });
    await screen.findByText('restored-setter:restored-setter');
    await act(async () => {
      client.setQueryData(STORED_USER_ID_QUERY_KEY, 'second-setter');
    });
    await waitFor(() => expect(screen.getByTestId('session').textContent).toBe('second-setter:second-setter'));
  });
  it('does not reuse a disabled query cached owner after signout', async () => {
    const { wrapper } = provider();
    const { rerender } = render(<Boundary />, { wrapper });
    await screen.findByText('restored-setter:restored-setter');
    auth.isAuthenticated = false;
    rerender(<Boundary />);
    expect(screen.getByTestId('session').textContent).toBe('none:none');
  });
});
