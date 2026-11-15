// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  authLabel: 'unchanged-owned-label' as string | null,
  nativeSearch: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn(),
  ready: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../../lib/graphql/use-http-query-scope', () => ({ useHttpQueryScope: () => selected.scope! }));
vi.mock('../../../lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: selected.authLabel }) }));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('../../../offline/assert-climb-delete-ready', () => ({ assertClimbDeleteReady: selected.ready }));
vi.mock('../../../offline/remove-deleted-climb', () => ({ removeDeletedClimbFromDevice: selected.remove }));
vi.mock('../../../lib/graphql/hooks', async () => {
  const draft = await import('../../../lib/graphql/hooks/use-delete-draft-climb');
  return { useDeleteDraftClimb: draft.useDeleteDraftClimb, useSearchClimbs: selected.nativeSearch };
});
vi.mock('../../../hooks/use-display-grade', () => ({ useBoardseshGradesActive: () => true }));
vi.mock('../../../lib/boardsesh-grades-preference', () => ({ useBoardseshGradesPreference: () => ({ loaded: true }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: selected.toast }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => selected.confirm }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 6: 24 } }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => <span>loading-drafts</span> }));
vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    children,
    onExpandedChange,
  }: {
    children?: ReactNode;
    onExpandedChange: (expanded: boolean) => void;
  }) => (
    <div>
      <button onClick={() => onExpandedChange(true)}>open-drafts</button>
      {children}
    </div>
  ),
}));
vi.mock('../DraftRow', () => ({
  DraftRow: ({
    climb,
    onPress,
    onDelete,
  }: {
    climb: Climb;
    onPress: (climb: Climb) => void;
    onDelete: (climb: Climb) => void;
  }) => (
    <div>
      <span>{climb.name}</span>
      <button onClick={() => onPress(climb)}>load-{climb.uuid}</button>
      <button onClick={() => onDelete(climb)}>delete-{climb.uuid}</button>
    </div>
  ),
}));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { SEARCH_CLIMBS_QUERY_KEY } from '../../../lib/graphql/query-keys';
import { OpenDraftsSection } from '../OpenDraftsSection';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 2, setIds: '1', angle: 40 };
const input = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '1',
  angle: 40,
  page: 0,
  pageSize: 50,
  onlyDrafts: true,
  draftScope: 'OWN',
  sortBy: 'creation',
  sortOrder: 'desc',
};
const closeFixtures: (() => void)[] = [];
const row = (name: string, uuid = name) => ({ uuid, name, userId: name, isDraft: true }) as unknown as Climb;
const envelope = (name: string) => ({ data: { searchClimbs: { climbs: [row(name)], totalCount: 1, hasMore: false } } });
function heldEnvelope(body: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
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
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const load = vi.fn();
  const section = () => <OpenDraftsSection board={board} onLoadDraft={load} />;
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return {
    ...http,
    cache,
    wrapper,
    load,
    section,
    change(kind: 'B' | 'ABA') {
      http.switchAccount('owned-B');
      if (kind === 'ABA') http.switchAccount('owned-A');
      selected.scope = http.scope();
    },
  };
}
beforeEach(() => {
  selected.authLabel = 'unchanged-owned-label';
  selected.confirm.mockReset().mockResolvedValue(true);
  selected.toast.mockReset();
  selected.ready.mockReset().mockResolvedValue(undefined);
  selected.remove.mockReset().mockResolvedValue(undefined);
  selected.nativeSearch.mockReset().mockImplementation(() => {
    if (selected.scope?.scoped) throw new Error('Selected drafts mounted raw native observer');
    return { data: { climbs: [row('native-local-draft')] }, isLoading: false, isError: false };
  });
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('owned drafts selected reader and action boundaries', () => {
  it.each(['B', 'ABA'] as const)('never mounts or paints a preloaded raw A cache under %s', async (change) => {
    const current = fixture();
    current.cache.setQueryData([...SEARCH_CLIMBS_QUERY_KEY, input], {
      searchClimbs: { climbs: [row('private-raw-A')] },
    });
    current.change(change);
    const held = heldEnvelope(envelope('fresh-owned-draft'));
    current.performFetch.mockResolvedValueOnce(held.response);
    const screen = render(current.section(), current);
    fireEvent.click(screen.getByText('open-drafts'));
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    expect(screen.queryByText('private-raw-A')).toBeNull();
    expect(selected.nativeSearch).not.toHaveBeenCalled();
    const sent = JSON.parse((current.performFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.variables.input).toEqual(input);
    await act(async () => {
      held.release();
    });
    await waitFor(() => expect(screen.getByText('fresh-owned-draft')).toBeTruthy());
    expect(current.cache.getQueryData([...SEARCH_CLIMBS_QUERY_KEY, input])).toEqual({
      searchClimbs: { climbs: [row('private-raw-A')] },
    });
  });

  it.each(['B', 'ABA'] as const)('does not reuse an old confirmation to delete after %s', async (change) => {
    const current = fixture();
    current.performFetch.mockResolvedValueOnce(Response.json(envelope('owned-draft')));
    const confirmation = deferred<boolean>();
    selected.confirm.mockReturnValueOnce(confirmation.promise);
    const screen = render(current.section(), current);
    fireEvent.click(screen.getByText('open-drafts'));
    await waitFor(() => expect(screen.getByText('owned-draft')).toBeTruthy());
    fireEvent.click(screen.getByText('delete-owned-draft'));
    expect(selected.confirm).toHaveBeenCalledOnce();
    current.change(change);
    screen.rerender(current.section());
    await act(async () => {
      confirmation.resolve(true);
    });
    expect(current.performFetch).toHaveBeenCalledTimes(1);
    expect(selected.toast).not.toHaveBeenCalled();
    expect(selected.remove).not.toHaveBeenCalled();
  });

  it('uses a fresh receipt for current deletion and preserves current draft loading', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, options) => {
      const request = JSON.parse((options as RequestInit).body as string) as { query: string };
      return Response.json(
        request.query.includes('deleteDraftClimb') ? { data: { deleteDraftClimb: true } } : envelope('owned-draft'),
      );
    });
    const screen = render(current.section(), current);
    fireEvent.click(screen.getByText('open-drafts'));
    await waitFor(() => expect(screen.getByText('owned-draft')).toBeTruthy());
    fireEvent.click(screen.getByText('load-owned-draft'));
    expect(current.load).toHaveBeenCalledExactlyOnceWith(row('owned-draft'));
    fireEvent.click(screen.getByText('delete-owned-draft'));
    await waitFor(() => expect(selected.toast).toHaveBeenCalledWith('draftsDrawer.delete.success', 'success'));
    expect(selected.remove).toHaveBeenCalledOnce();
    const bodies = current.performFetch.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies.find((body) => body.query.includes('deleteDraftClimb')).variables).toEqual({
      uuid: 'owned-draft',
      boardType: 'kilter',
    });
  });

  it('keeps native local-first drafts on the unchanged search hook', () => {
    const current = fixture();
    selected.scope = {
      scoped: false,
      scope: undefined,
      assertView: () => {},
      isReady: () => true,
    } as unknown as HttpQueryScope;
    const screen = render(current.section(), current);
    fireEvent.click(screen.getByText('open-drafts'));
    expect(selected.nativeSearch).toHaveBeenLastCalledWith(input as ClimbSearchInput, true);
    expect(screen.getByText('native-local-draft')).toBeTruthy();
    fireEvent.click(screen.getByText('load-native-local-draft'));
    expect(current.load).toHaveBeenCalledExactlyOnceWith(row('native-local-draft'));
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('does not fetch or display private drafts without an authenticated current view', () => {
    const current = fixture();
    selected.authLabel = null;
    const screen = render(current.section(), current);
    fireEvent.click(screen.getByText('open-drafts'));
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(selected.nativeSearch).not.toHaveBeenCalled();
    expect(current.load).not.toHaveBeenCalled();
  });
});
