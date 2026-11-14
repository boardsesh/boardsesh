// @vitest-environment jsdom
import { createElement, useCallback, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
vi.mock('../../../lib/graphql/use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing owned row view');
    return selected.scope;
  },
}));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: 'owned-token-label' }) }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { separator: '#ccc', fill: '#eee', secondaryLabel: '#666' },
    brandColors: { primary: '#333', error: '#f00' },
  }),
}));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => '2h' }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Avatar', () => ({ Avatar: () => createElement('span', null) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    disabled,
    loading,
    onPress,
  }: {
    title: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) =>
    createElement(
      'button',
      { disabled, onClick: onPress, 'data-button': title, 'data-loading': Boolean(loading) },
      title,
    ),
}));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { useHttpActionScope } from '../../../lib/graphql/use-http-action-scope';
import {
  useAnswerFollowRequestMutation,
  GROUPED_NOTIFICATIONS_QUERY_KEY,
  NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
} from '../../../lib/graphql/hooks/use-notifications';
import { FollowRequestNotificationRow, type AnswerFollowRequest } from '../FollowRequestNotificationRow';

type Receipt = Awaited<ReturnType<ReturnType<typeof useAnswerFollowRequestMutation>['mutateWithReceipt']>>;
type Pages = { pages: GroupedNotificationConnection[]; pageParams: number[] };
const closeFixtures: (() => void)[] = [];
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});
function notification(uuid: string): GroupedNotification {
  return {
    uuid,
    type: 'follow_request',
    entityType: null,
    entityId: `requester-${uuid}`,
    actorCount: 1,
    actors: [{ id: `requester-${uuid}`, displayName: uuid, avatarUrl: null }],
    isRead: false,
    createdAt: '2026-08-14T10:00:00.000Z',
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
  } as GroupedNotification;
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const accepted: Receipt[] = [];
  const errors: unknown[] = [];
  const signals: AbortSignal[] = [];
  const seed = (uuid: string) => {
    const pages: Pages = {
      pages: [{ groups: [notification(uuid)], totalCount: 1, unreadCount: 9, hasMore: false }],
      pageParams: [0],
    };
    cache.setQueryData(selected.scope!.key(GROUPED_NOTIFICATIONS_QUERY_KEY), pages);
    cache.setQueryData(selected.scope!.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY), 9);
  };
  seed('A');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  function Harness({
    uuid,
    hideWhenRemoved = false,
    afterReceipt,
  }: {
    uuid: string;
    hideWhenRemoved?: boolean;
    afterReceipt?: () => Promise<void>;
  }) {
    const action = useHttpActionScope();
    const { mutateWithReceipt } = useAnswerFollowRequestMutation();
    const onAnswer = useCallback<AnswerFollowRequest>(
      async (input, options) => {
        signals.push(options.signal);
        try {
          const receipt = await mutateWithReceipt(input, options);
          accepted.push(receipt);
          await afterReceipt?.();
          return receipt;
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
      [mutateWithReceipt, afterReceipt],
    );
    const { data: pages } = useQuery<Pages>({
      queryKey: selected.scope!.key(GROUPED_NOTIFICATIONS_QUERY_KEY),
      enabled: false,
    });
    const { data: unread } = useQuery<number>({
      queryKey: selected.scope!.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY),
      enabled: false,
    });
    const show = !hideWhenRemoved || pages?.pages.some((page) => page.groups.some((group) => group.uuid === uuid));
    return (
      <>
        <span data-testid="unread">{unread}</span>
        {show ? (
          <FollowRequestNotificationRow
            key={action.key}
            notification={notification(uuid)}
            onPress={() => {}}
            onAnswer={onAnswer}
            captureAction={action.capture}
          />
        ) : null}
      </>
    );
  }
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, seed, wrapper, Harness, accepted, errors, signals };
}
function heldResponse(fails = false) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify(
              fails ? { errors: [{ message: 'Owned request refused' }] } : { data: { approveFollowRequest: true } },
            ),
          ),
        );
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
const approve = () => screen.getByRole('button', { name: 'followRequest.approve' });

describe('actual follow-request UI and original SDK receipt', () => {
  it('finishes the successful cache publication when that publication removes its row', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(Response.json({ data: { approveFollowRequest: true } }));
    render(<current.Harness uuid="A" hideWhenRemoved />, current);
    fireEvent.click(approve());
    await waitFor(() => expect(current.accepted).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'followRequest.approve' })).toBeNull());
    expect(screen.getByTestId('unread').textContent).toBe('8');
    expect(current.errors).toHaveLength(0);
    expect(current.signals[0].aborted).toBe(false);
    current.accepted[0].assertCurrent();
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['B', 'ABA'] as const)('cannot publish an old result or clear a new pending row after %s', async (change) => {
    const current = fixture();
    const old = heldResponse();
    const fresh = heldResponse();
    current.performFetch.mockResolvedValueOnce(old.response).mockResolvedValueOnce(fresh.response);
    const { rerender } = render(<current.Harness uuid="A" />, current);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.seed('fresh');
    rerender(<current.Harness uuid="fresh" />);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.release();
    });
    expect(screen.queryByText('followRequest.failed')).toBeNull();
    expect(approve().getAttribute('data-loading')).toBe('true');
    expect((approve() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fresh.release();
    });
    await waitFor(() => expect(current.accepted).toHaveLength(1));
    expect(current.performFetch).toHaveBeenCalledTimes(2);
  });

  it('does not let an earlier failure reset a recycled same-view row', async () => {
    const current = fixture();
    const old = heldResponse(true);
    const fresh = heldResponse();
    current.performFetch.mockResolvedValueOnce(old.response).mockResolvedValueOnce(fresh.response);
    const { rerender } = render(<current.Harness uuid="A" />, current);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    rerender(<current.Harness uuid="second" />);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.release();
    });
    await waitFor(() => expect(current.errors).toHaveLength(1));
    expect(screen.queryByText('followRequest.failed')).toBeNull();
    expect(approve().getAttribute('data-loading')).toBe('true');
    await act(async () => {
      fresh.release();
    });
    await waitFor(() => expect(current.accepted).toHaveLength(1));
  });

  it('does not let an earlier failure reset the same UUID after cell recycling goes A-to-B-to-A', async () => {
    const current = fixture();
    const first = heldResponse(true);
    const second = heldResponse();
    const third = heldResponse();
    current.performFetch
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
      .mockResolvedValueOnce(third.response);
    const { rerender } = render(<current.Harness uuid="A" />, current);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    rerender(<current.Harness uuid="second" />);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    rerender(<current.Harness uuid="A" />);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
    await act(async () => {
      first.release();
    });
    await waitFor(() => expect(current.errors).toHaveLength(1));
    expect(screen.queryByText('followRequest.failed')).toBeNull();
    expect(approve().getAttribute('data-loading')).toBe('true');
    expect((approve() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      second.release();
      third.release();
    });
    await waitFor(() => expect(current.accepted).toHaveLength(2));
    expect(current.performFetch).toHaveBeenCalledTimes(3);
  });

  it('checks the original delivery after a later UI await despite a fresh same-owner lease', async () => {
    const current = fixture();
    let release!: () => void;
    const afterReceipt = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    current.performFetch.mockResolvedValueOnce(Response.json({ data: { approveFollowRequest: true } }));
    render(<current.Harness uuid="A" afterReceipt={afterReceipt} />, current);
    fireEvent.click(approve());
    await waitFor(() => expect(current.accepted).toHaveLength(1));
    current.clock(90_000);
    const fresh = await current.backend.acquire(current.backend.getSnapshot().owner!);
    current.clock(120_001);
    await act(async () => {
      release();
    });
    expect(await screen.findByText('followRequest.failed')).not.toBeNull();
    current.backend.assertCurrent(current.backend.capture(fresh.token)!, fresh);
    expect(current.issueLease).toHaveBeenCalledTimes(2);
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels the original request when the whole screen leaves without retiring the account', async () => {
    const current = fixture();
    const held = heldResponse();
    current.performFetch.mockResolvedValueOnce(held.response);
    const { unmount } = render(<current.Harness uuid="A" />, current);
    fireEvent.click(approve());
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    unmount();
    expect(current.signals[0].aborted).toBe(true);
    await act(async () => {
      held.release();
    });
    await waitFor(() => expect(current.errors).toHaveLength(1));
    expect(current.accepted).toHaveLength(0);
    expect(current.backend.getSnapshot().owner?.userId).toBe('owned-A');
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  });
});
