import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import BoardMergesPanel from '../board-merges-panel';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.setConfig({ testTimeout: 15_000 });

const request = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ token: 'token', userId: 'reporter' }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: identity.userId } } }) }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: identity.token }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ useLocaleRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@boardsesh/graphql/operations', () => ({
  BOARD_MERGE_CANDIDATES: 'candidates',
  BOARD_MERGE_PREVIEW: 'preview',
  BOARD_MERGE_REQUESTS: 'requests',
  REQUEST_BOARD_MERGE: 'request',
  MERGE_BOARDS: 'merge',
  RESOLVE_BOARD_MERGE_REQUEST: 'resolve',
  GET_BOARD: 'board',
}));
const boards = [
  {
    uuid: 'first',
    name: 'Mammoth TB2',
    boardType: 'tension',
    layoutId: 10,
    sizeId: 6,
    setIds: '12,13',
    angle: 30,
    isPublic: true,
  },
  {
    uuid: 'second',
    name: 'Mammoth duplicate',
    boardType: 'tension',
    layoutId: 11,
    sizeId: 6,
    setIds: '13,12',
    angle: 40,
    isPublic: true,
  },
];
let canMerge = false;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BoardMergesPanel />
    </QueryClientProvider>,
  );
}
async function selectBoards() {
  fireEvent.click(await screen.findByRole('checkbox', { name: /Mammoth TB2/ }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /Mammoth duplicate/ }));
  await screen.findByRole('radio', { name: /Mammoth TB2/ });
  fireEvent.change(screen.getByRole('textbox', { name: /Why are these/ }), {
    target: { value: 'Both listings are the same physical wall.' },
  });
}
beforeEach(() => {
  request.mockReset();
  canMerge = false;
  identity.token = 'token';
  identity.userId = 'reporter';
  request.mockImplementation(async (operation: string) => {
    if (operation === 'candidates') return { boardMergeCandidates: { boards, hasMore: false } };
    if (operation === 'requests') return { boardMergeRequests: { requests: [], hasMore: false } };
    if (operation === 'preview')
      return { boardMergePreview: { boards, suggestedCanonicalBoardUuid: 'first', canMerge, version: 'v1' } };
    return {};
  });
});
describe('board merge flow', () => {
  it('approves a queued request using the current comparison and chosen survivor', async () => {
    canMerge = true;
    const fallback = request.getMockImplementation();
    request.mockImplementation((operation: string, ...args: unknown[]) =>
      operation === 'requests'
        ? Promise.resolve({
            boardMergeRequests: {
              requests: [
                {
                  uuid: 'queued-request',
                  status: 'open',
                  reason: 'Both listings are the same physical wall.',
                  canonicalBoardUuid: 'first',
                  boardUuids: ['first', 'second'],
                  boards,
                  reports: [{ reason: 'The second listing was imported twice.', createdAt: '2026-11-23' }],
                  canResolve: true,
                },
              ],
              hasMore: false,
            },
          })
        : fallback?.(operation, ...args),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByRole('radio', { name: /Mammoth TB2/ });
    expect(screen.getByText('The second listing was imported twice.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Mammoth duplicate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Board cleanup saved.');
    expect(request).toHaveBeenCalledWith('resolve', {
      input: {
        requestUuid: 'queued-request',
        approve: true,
        canonicalBoardUuid: 'second',
        version: 'v1',
        reason: 'Both listings are the same physical wall.',
      },
    });
  });

  it('lets a reporter request a merge without granting direct merge access', async () => {
    mount();
    await selectBoards();
    expect(screen.queryByRole('button', { name: 'Merge boards' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request merge' }));
    await screen.findByText('Merge requested. An authorized reviewer can now check it.');
    expect(request).toHaveBeenCalledWith('request', {
      input: {
        boardUuids: ['first', 'second'],
        canonicalBoardUuid: 'first',
        reason: 'Both listings are the same physical wall.',
      },
    });
  });
  it('requires confirmation, focuses Cancel, and preserves the preview version', async () => {
    canMerge = true;
    mount();
    await selectBoards();
    fireEvent.click(screen.getByRole('button', { name: 'Merge boards' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    expect(request.mock.calls.some(([operation]) => operation === 'merge')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Board cleanup saved.');
    expect(request).toHaveBeenCalledWith('merge', {
      input: {
        boardUuids: ['first', 'second'],
        canonicalBoardUuid: 'first',
        version: 'v1',
        reason: 'Both listings are the same physical wall.',
      },
    });
  });
  it('shows retry after a failed merge and keeps the selected boards', async () => {
    canMerge = true;
    const fallback = request.getMockImplementation();
    request.mockImplementation((operation: string, ...args: unknown[]) =>
      operation === 'merge' ? Promise.reject(new Error('stale')) : fallback?.(operation, ...args),
    );
    mount();
    await selectBoards();
    fireEvent.click(screen.getByRole('button', { name: 'Merge boards' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Couldn’t complete that. Check the selection and try again.');
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
  });
});
