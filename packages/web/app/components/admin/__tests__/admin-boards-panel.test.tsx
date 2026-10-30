import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AdminBoard } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import AdminBoardsPanel from '../admin-boards-panel';

const mockRequest = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());
const sessionHolder = vi.hoisted(() => ({ userId: 'global-admin' }));
const editorProps = vi.hoisted(() => ({
  board: null as AdminBoard | null,
  onSuccess: null as ((updated: AdminBoard) => Promise<void>) | null,
}));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: sessionHolder.userId } } }) }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'admin-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: mockRequest }) }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ useLocaleRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('@boardsesh/graphql/operations', () => ({ ADMIN_BOARDS: 'ADMIN_BOARDS', ADMIN_BOARD: 'ADMIN_BOARD' }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock('@/app/components/board-entity/edit-board-form', () => ({
  default: ({
    board,
    mode,
    onSuccess,
    onCancel,
  }: {
    board: AdminBoard;
    mode: string;
    onSuccess: (updated: AdminBoard) => Promise<void>;
    onCancel: () => void;
  }) => {
    editorProps.board = board;
    editorProps.onSuccess = onSuccess;
    return (
      <div>
        <span>
          {mode} editor: {board.name}
        </span>
        <button onClick={() => void onSuccess({ ...board, name: 'Bowlo MoonBoard' })}>Save test board</button>
        <button onClick={onCancel}>Cancel test editor</button>
      </div>
    );
  },
}));

const moonBoard: AdminBoard = {
  uuid: '31d15c70-d777-4b52-bb26-84cb70795847',
  slug: 'moonboard-old-name',
  ownerId: 'board-owner',
  ownerDisplayName: 'Board owner',
  boardType: 'moonboard',
  layoutId: 1,
  sizeId: 1,
  setIds: '1',
  name: 'MoonBoard',
  description: 'Private board description',
  locationName: 'Actual board location',
  latitude: 40,
  longitude: 23,
  isPublic: false,
  isUnlisted: false,
  hideLocation: true,
  isOwned: true,
  angle: 40,
  isAngleAdjustable: false,
  hasLeds: true,
  serialNumber: null,
  timerName: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  gymUuid: null,
  gymName: null,
  gymSlug: null,
  canEdit: true,
};

function connection(boards = [moonBoard], hasMore = false) {
  return { adminBoards: { boards, totalCount: hasMore ? 21 : boards.length, hasMore } };
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AdminBoardsPanel viewerUserId="global-admin" />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionHolder.userId = 'global-admin';
  editorProps.board = null;
  editorProps.onSuccess = null;
  mockRequest.mockImplementation(async (document: string) =>
    document === 'ADMIN_BOARD' ? { adminBoard: moonBoard } : connection(),
  );
});

describe('AdminBoardsPanel', () => {
  it('lists private unlinked boards and loads a complete record only when editing', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Edit MoonBoard' });
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('No gym linked')).toBeTruthy();
    expect(screen.queryByText('Private board description')).toBeNull();
    expect(mockRequest).not.toHaveBeenCalledWith('ADMIN_BOARD', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Edit MoonBoard' }));
    await screen.findByText('admin editor: MoonBoard');
    expect(editorProps.board?.description).toBe('Private board description');
    expect(screen.queryByRole('link', { name: 'Back to admin' })).toBeNull();
  });

  it('preserves search and pagination when returning from an edit and refreshes after saving', async () => {
    mockRequest.mockImplementation(async (document: string) =>
      document === 'ADMIN_BOARD' ? { adminBoard: moonBoard } : connection([moonBoard], true),
    );
    renderPanel();
    await screen.findByRole('button', { name: 'Edit MoonBoard' });
    fireEvent.change(screen.getByLabelText('Search boards'), { target: { value: '  bowlo  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('ADMIN_BOARDS', {
        input: { query: 'bowlo', boardType: undefined, limit: 20, offset: 0 },
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('ADMIN_BOARDS', {
        input: { query: 'bowlo', boardType: undefined, limit: 20, offset: 20 },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit MoonBoard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save test board' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Search boards') as HTMLInputElement).value).toBe('  bowlo  ');
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps the editor baseline stable when its query cache changes', async () => {
    const { queryClient } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit MoonBoard' }));
    await screen.findByText('admin editor: MoonBoard');
    await act(async () =>
      queryClient.setQueryData(['adminBoard', 'global-admin', moonBoard.uuid], {
        ...moonBoard,
        name: 'Concurrent rename',
        description: 'Concurrent description',
      }),
    );
    expect(editorProps.board?.name).toBe('MoonBoard');
    expect(editorProps.board?.description).toBe('Private board description');
  });

  it('hides the editing snapshot immediately when the account changes', async () => {
    const { rerender, queryClient } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit MoonBoard' }));
    await screen.findByText('admin editor: MoonBoard');
    sessionHolder.userId = 'different-admin';
    rerender(
      <QueryClientProvider client={queryClient}>
        <AdminBoardsPanel viewerUserId="global-admin" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('admin editor: MoonBoard')).toBeNull();
    expect(screen.getByText('Please sign in to access the admin panel.')).toBeTruthy();
  });

  it('shows detail failures with retry and a route back to the list', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document === 'ADMIN_BOARD') throw new Error('Board unavailable');
      return connection();
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit MoonBoard' }));
    await screen.findByText("Couldn't load this board for editing.");
    mockRequest.mockResolvedValueOnce({ adminBoard: moonBoard });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('admin editor: MoonBoard');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel test editor' }));
    await screen.findByRole('button', { name: 'Edit MoonBoard' });
  });

  it('ignores an old save callback after switching accounts', async () => {
    const { rerender, queryClient } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit MoonBoard' }));
    await screen.findByText('admin editor: MoonBoard');
    const oldSave = editorProps.onSuccess;
    sessionHolder.userId = 'different-admin';
    rerender(
      <QueryClientProvider client={queryClient}>
        <AdminBoardsPanel viewerUserId="global-admin" />
      </QueryClientProvider>,
    );
    await act(async () => {
      await oldSave?.(moonBoard);
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not replace a newer search with an older late response', async () => {
    let resolveOldSearch!: (response: ReturnType<typeof connection>) => void;
    mockRequest.mockImplementation(async (_document: string, variables: { input: { query?: string } }) => {
      if (variables.input.query === 'old')
        return new Promise((resolve) => {
          resolveOldSearch = resolve;
        });
      return connection([{ ...moonBoard, name: variables.input.query === 'new' ? 'New result' : 'MoonBoard' }]);
    });
    renderPanel();
    await screen.findByRole('button', { name: 'Edit MoonBoard' });
    fireEvent.change(screen.getByLabelText('Search boards'), { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(resolveOldSearch).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Search boards'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('New result');
    await act(async () => resolveOldSearch(connection([{ ...moonBoard, name: 'Old result' }])));
    expect(screen.queryByText('Old result')).toBeNull();
    expect(screen.getByText('New result')).toBeTruthy();
  });
});
