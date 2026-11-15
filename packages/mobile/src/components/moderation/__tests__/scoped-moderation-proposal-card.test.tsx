// @vitest-environment jsdom
import type { Context, ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  context: null as Context<HttpQueryScope | null> | null,
  confirm: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn(),
}));
vi.mock('../../../lib/graphql/use-http-query-scope', async () => {
  const { createContext, useContext } = await import('react');
  const context = createContext<HttpQueryScope | null>(null);
  selected.context = context;
  return { useHttpQueryScope: () => useContext(context)! };
});
vi.mock('../../../lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: 'unchanged-owned-label' }) }));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => selected.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: selected.toast }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { md: 8, full: 999 },
  opacity: { disabled: 0.5 },
}));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => null }) }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));
vi.mock('@boardsesh/profile-stats', () => ({ getLayoutDisplayName: () => 'Layout' }));
vi.mock('@boardsesh/community-roles', () => ({ rolesGrantAdmin: () => true, rolesGrantAdminOrLeader: () => true }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../Card', () => ({ Card: ({ children }: { children?: ReactNode }) => <div>{children}</div> }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => <span>loading</span> }));
vi.mock('../../ClimbListThumbnail', () => ({ ClimbListThumbnail: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock('../../climb-actions/ClimbActionsPressable', () => ({
  ClimbActionsPressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock('../../../lib/graphql/hooks/use-social', () => ({
  useComments: () => ({
    data: { comments: [{ uuid: 'first-reason', userId: 'proposer', body: 'The holds came off', isDeleted: false }] },
    isPending: false,
    isError: false,
  }),
}));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { ModerationProposalCard } from '../ModerationProposalCard';
import { ProposalReasonsList } from '../ProposalReasonsList';

const closeFixtures: (() => void)[] = [];
function proposal(): Proposal {
  return {
    uuid: 'owned-proposal',
    climbUuid: 'owned-climb',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    proposerId: 'proposer',
    proposerDisplayName: 'Crew',
    climbName: 'Owned climb',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    reason: 'The holds came off',
    createdAt: '2026-09-01T10:00:00Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 1,
  } as Proposal;
}
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  return {
    promise: new Promise<Result>((complete) => {
      resolve = complete;
    }),
    resolve: (result: Result) => resolve(result),
  };
}
function heldEnvelope(envelope: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ScopeContext = selected.context!;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ScopeContext.Provider value={selected.scope}>
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    </ScopeContext.Provider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return {
    ...http,
    cache,
    wrapper,
    change(kind: 'B' | 'ABA') {
      http.switchAccount('owned-B');
      if (kind === 'ABA') http.switchAccount('owned-A');
      selected.scope = http.scope();
    },
  };
}
function card() {
  return (
    <ModerationProposalCard
      proposal={proposal()}
      roles={[]}
      isSignedIn
      onOpenClimb={vi.fn()}
      onLongPressClimb={() => null}
    />
  );
}
beforeEach(() => {
  selected.confirm.mockReset().mockResolvedValue(true);
  selected.toast.mockReset();
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('actual proposal card account ownership', () => {
  it.each(['B', 'ABA'] as const)('never dispatches an old moderation confirmation after %s', async (change) => {
    const current = fixture();
    const confirmation = deferred<boolean>();
    selected.confirm.mockReturnValueOnce(confirmation.promise);
    const screen = render(card(), current);
    fireEvent.click(screen.getByText('proposalCard.approve'));
    await waitFor(() => expect(selected.confirm).toHaveBeenCalledOnce());
    current.change(change);
    screen.rerender(card());
    await act(async () => {
      confirmation.resolve(true);
    });
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(selected.toast).not.toHaveBeenCalled();
  });

  it('keeps a current confirmed moderator action and exact variables', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(
      Response.json({ data: { resolveProposal: { ...proposal(), status: 'approved' } } }),
    );
    const screen = render(card(), current);
    fireEvent.click(screen.getByText('proposalCard.approve'));
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText('proposalCard.approve').closest('button')?.disabled).toBe(false));
    const sent = JSON.parse((current.performFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.variables).toEqual({ input: { proposalUuid: 'owned-proposal', status: 'approved' } });
    expect(selected.toast).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA', 'expired'] as const)('silences a held vote failure after %s', async (change) => {
    const current = fixture();
    const held = heldEnvelope({ errors: [{ message: 'Owned rejection', extensions: { code: 'BAD_USER_INPUT' } }] });
    current.performFetch.mockResolvedValueOnce(held.response);
    const screen = render(card(), current);
    fireEvent.click(screen.getByText('proposalCard.support'));
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    if (change === 'expired') {
      current.clock(90_000);
      current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
      await selected.scope!.run((operation) => operation.request('{ viewer { id } }'));
      current.clock(120_001);
    } else {
      current.change(change);
      screen.rerender(card());
    }
    await act(async () => {
      held.release();
    });
    expect(selected.toast).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA'] as const)(
    'resets expanded private diagnostics before mounting the new %s view',
    async (change) => {
      const current = fixture();
      current.performFetch.mockResolvedValueOnce(
        Response.json({
          data: {
            proposalReportReleaseContexts: [
              {
                commentUuid: 'first-reason',
                releaseContext: { channel: 'private-A-diagnostic', updateId: 'private-A-update' },
              },
            ],
          },
        }),
      );
      const screen = render(card(), current);
      fireEvent.click(screen.getByText('mobile.reportRelease.title'));
      await waitFor(() => expect(screen.getByText(/private-A-update/)).toBeTruthy());
      current.change(change);
      const held = heldEnvelope({
        data: {
          proposalReportReleaseContexts: [
            { commentUuid: 'first-reason', releaseContext: { updateId: 'fresh-diagnostic' } },
          ],
        },
      });
      current.performFetch.mockResolvedValueOnce(held.response);
      screen.rerender(card());
      expect(screen.queryByText(/private-A-update/)).toBeNull();
      expect(current.performFetch).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText('mobile.reportRelease.title'));
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      await act(async () => {
        held.release();
      });
      await waitFor(() => expect(screen.getByText(/fresh-diagnostic/)).toBeTruthy());
    },
  );

  it('hides loaded private diagnostics immediately when the same scope becomes unavailable', async () => {
    const current = fixture();
    const scope = selected.scope!;
    current.performFetch.mockResolvedValueOnce(
      Response.json({
        data: {
          proposalReportReleaseContexts: [
            {
              commentUuid: 'first-reason',
              releaseContext: { updateId: 'private-A-update' },
            },
          ],
        },
      }),
    );
    const props = {
      proposalUuid: 'owned-proposal',
      proposerId: 'proposer',
      reason: 'The holds came off',
      expanded: true,
      canReadReleaseContext: true,
    };
    const screen = render(<ProposalReasonsList {...props} />, current);
    await waitFor(() => expect(screen.getByText(/private-A-update/)).toBeTruthy());
    selected.scope = { ...scope, isReady: () => false };
    screen.rerender(<ProposalReasonsList {...props} />);
    expect(screen.queryByText(/private-A-update/)).toBeNull();
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  });
});
