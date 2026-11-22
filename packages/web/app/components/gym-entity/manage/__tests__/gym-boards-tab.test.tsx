import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym, StrayBoard, UserBoard } from '@boardsesh/shared-schema';
import GymBoardsTab, { GymBoardAssociation, VisibilityChip } from '../gym-boards-tab';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockShowMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockToken = vi.hoisted(() => ({ current: 'test-token' }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: mockToken.current, isAuthenticated: true, isLoading: false, error: null }),
}));

const mockRefresh = vi.hoisted(() => vi.fn());
const mockEditorSaved = vi.hoisted(() => ({ current: null as ((board: UserBoard) => void) | null }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ useLocaleRouter: () => ({ refresh: mockRefresh }) }));

vi.mock('@/app/components/board-entity/edit-board-form', () => ({
  default: ({
    board,
    onSuccess,
    onDirtyChange,
  }: {
    board: UserBoard;
    onSuccess: (updated: UserBoard) => void;
    onDirtyChange?: (dirty: boolean) => void;
  }) => {
    mockEditorSaved.current = onSuccess;
    const [draft, setDraft] = React.useState(board.name);
    return (
      <div data-testid="hydrated-editor">
        <input
          aria-label="Draft name"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            onDirtyChange?.(true);
          }}
        />
        <span>{board.description}</span>
        <button onClick={() => onSuccess({ ...board, name: draft })}>Save editor</button>
      </div>
    );
  },
}));

const mockSessionUserId = { current: 'user-owner' };
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: mockSessionUserId.current } }, status: 'authenticated' }),
}));

// One shared execute mock for the board association mutations;
// tests control its resolution to exercise the success and failure paths.
const mockExecute = vi.fn();
vi.mock('@/app/hooks/use-entity-mutation', () => ({
  useEntityMutation: () => ({ execute: mockExecute, token: 'test-token' }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const GYM_UUID = 'gym-uuid-1';

const gym = {
  uuid: GYM_UUID,
  ownerId: 'user-owner',
  myRole: 'admin',
  name: 'Test Gym',
  slug: 'test-gym',
} as unknown as Gym;

function makeBoard(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'board-1',
    ownerId: 'user-owner',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    name: 'Garage Board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
  } as UserBoard;
}

/** Routes the shared request mock by operation: strayBoardsForGym vs gymBoards vs myBoards. */
function stubRequests({
  gymBoards,
  myBoards,
  strays = [],
  gymDetails = gym,
}: {
  gymBoards: UserBoard[];
  myBoards: UserBoard[];
  strays?: StrayBoard[];
  gymDetails?: Gym;
}) {
  mockRequest.mockImplementation(async (document: string) => {
    // strayBoardsForGym must be matched before gymBoards — both are board reads.
    if (typeof document === 'string' && document.includes('strayBoardsForGym')) {
      return { strayBoardsForGym: strays };
    }
    if (typeof document === 'string' && document.includes('gymBoards')) {
      return { gymBoards };
    }
    if (typeof document === 'string' && document.includes('query GetGym(')) {
      return { gym: gymDetails };
    }
    return { myBoards: { boards: myBoards, totalCount: myBoards.length, hasMore: false } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionUserId.current = 'user-owner';
  mockToken.current = 'test-token';
  mockEditorSaved.current = null;
});

describe('GymBoardsTab — add-board dialog', () => {
  const candidate = makeBoard({ uuid: 'board-new', name: 'New Wall', gymUuid: null });

  async function openDialogWithCandidate() {
    stubRequests({ gymBoards: [], myBoards: [candidate] });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /add a board/i }));
    await screen.findByText('New Wall');
  }

  it('keeps the candidate visible when the link mutation fails, so the user can retry', async () => {
    await openDialogWithCandidate();
    mockExecute.mockResolvedValueOnce(null); // useEntityMutation resolves null on failure

    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(1));
    expect(screen.getByText('New Wall')).toBeTruthy();
  });

  it('removes the candidate after a successful link', async () => {
    await openDialogWithCandidate();
    mockExecute.mockResolvedValueOnce({ linkBoardToGym: true });

    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));

    await waitFor(() => expect(screen.queryByText('New Wall')).toBeNull());
  });

  it('loads one more page when followed boards fill the first page', async () => {
    mockRequest.mockImplementation(async (document: string, variables?: { input?: { offset?: number } }) => {
      if (document.includes('gymBoards')) return { gymBoards: [] };
      if (document.includes('strayBoardsForGym')) return { strayBoardsForGym: [] };
      if (variables?.input?.offset === 0) {
        return {
          myBoards: {
            boards: Array.from({ length: 50 }, (_, index) =>
              makeBoard({ uuid: `followed-${index}`, ownerId: 'another-user' }),
            ),
            totalCount: 51,
            hasMore: true,
          },
        };
      }
      return { myBoards: { boards: [candidate], totalCount: 51, hasMore: false } };
    });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /add a board/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more boards' }));
    await screen.findByText('New Wall');
    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), { input: { limit: 50, offset: 50 } });
    mockExecute.mockResolvedValueOnce({ linkBoardToGym: true });
    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));
    await waitFor(() => expect(screen.queryByText('New Wall')).toBeNull());
  });
});

describe('GymBoardsTab — permission gating', () => {
  it('hides Unlink and shows the owner-only note for boards the viewer does not own', async () => {
    stubRequests({
      gymBoards: [makeBoard({ uuid: 'board-foreign', name: 'Foreign Board', ownerId: 'someone-else' })],
      myBoards: [],
    });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);

    await screen.findByText('Foreign Board');
    expect(screen.queryByRole('button', { name: /unlink/i })).toBeNull();
    expect(screen.getByText(/only the board's owner can unlink it/i)).toBeTruthy();
  });

  it('hides the add-board affordance for gym editors and shows the read-only hint', async () => {
    mockSessionUserId.current = 'user-editor';
    const editorGym = { ...gym, ownerId: 'user-owner', myRole: 'editor' } as unknown as Gym;
    stubRequests({ gymBoards: [], myBoards: [] });
    render(<GymBoardsTab gym={editorGym} onGymChange={vi.fn()} />);

    await screen.findByText(/no boards linked yet/i);
    expect(screen.queryByRole('button', { name: /add a board/i })).toBeNull();
    expect(screen.getByText(/only the gym owner or an admin can link boards/i)).toBeTruthy();
  });
});

describe('GymBoardAssociation — unlink cache refresh', () => {
  it.each([true, false])(
    'refreshes directory only after a successful unlink (success: %s)',
    async (mutationSucceeds) => {
      const onAssociated = vi.fn().mockResolvedValue(undefined);
      stubRequests({ gymBoards: [makeBoard({ gymUuid: GYM_UUID })], myBoards: [] });
      mockExecute.mockResolvedValueOnce(mutationSucceeds ? { linkBoardToGym: true } : null);
      render(<GymBoardAssociation gym={gym} onAssociated={onAssociated} />);

      fireEvent.click(await screen.findByRole('button', { name: /^unlink$/i }));
      const confirmation = await screen.findByRole('dialog');
      fireEvent.click(within(confirmation).getByRole('button', { name: /unlink/i }));

      await waitFor(() => expect(mockExecute).toHaveBeenCalledWith({ input: { boardUuid: 'board-1', gymUuid: null } }));
      if (mutationSucceeds) {
        await waitFor(() => expect(onAssociated).toHaveBeenCalledTimes(1));
      } else {
        expect(onAssociated).not.toHaveBeenCalled();
        expect(screen.getByText('Garage Board')).toBeTruthy();
      }
    },
  );
});

describe('GymBoardsTab — delete board', () => {
  const linkedBoard = makeBoard({ gymUuid: GYM_UUID });

  it.each([
    { viewer: 'user-owner', boardOwner: 'user-owner', role: 'editor' as const, gymOwner: 'gym-owner' },
    { viewer: 'user-owner', boardOwner: 'board-owner', role: null, gymOwner: 'user-owner' },
    { viewer: 'gym-admin', boardOwner: 'board-owner', role: 'admin' as const, gymOwner: 'gym-owner' },
  ])('offers Delete for $viewer with gym role $role', async ({ viewer, boardOwner, role, gymOwner }) => {
    mockSessionUserId.current = viewer;
    stubRequests({ gymBoards: [{ ...linkedBoard, ownerId: boardOwner }], myBoards: [] });
    render(<GymBoardsTab gym={{ ...gym, ownerId: gymOwner, myRole: role }} onGymChange={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /^delete$/i })).toBeTruthy();
  });

  it('offers Delete to gym admins when location privacy redacts a listed board gym link', async () => {
    mockSessionUserId.current = 'gym-admin';
    stubRequests({
      gymBoards: [{ ...linkedBoard, ownerId: 'board-owner', gymUuid: null, hideLocation: true }],
      myBoards: [],
    });
    render(<GymBoardsTab gym={{ ...gym, isPublic: false }} onGymChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    mockExecute.mockResolvedValueOnce({ deleteBoard: true });
    stubRequests({ gymBoards: [], myBoards: [] });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText('Garage Board')).toBeNull());
    expect(mockExecute).toHaveBeenCalledExactlyOnceWith({ boardUuid: linkedBoard.uuid });
  });

  it.each(['editor', null] as const)('hides Delete when gym role %s only grants editing', async (role) => {
    mockSessionUserId.current = 'gym-editor';
    stubRequests({ gymBoards: [{ ...linkedBoard, ownerId: 'board-owner', canEdit: true }], myBoards: [] });
    render(<GymBoardsTab gym={{ ...gym, myRole: role }} onGymChange={vi.fn()} />);

    await screen.findByText('Garage Board');
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('keeps gym setup free of delete actions', async () => {
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    render(<GymBoardAssociation gym={gym} />);

    await screen.findByText('Garage Board');
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('names the board, focuses Cancel, and leaves it unchanged when cancelled', async () => {
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    const confirmation = await screen.findByRole('dialog');
    expect(within(confirmation).getByText('Delete "Garage Board"? This can\'t be undone.')).toBeTruthy();
    const cancelButton = within(confirmation).getByRole('button', { name: /^cancel$/i });
    expect(document.activeElement).toBe(cancelButton);
    expect(mockExecute).not.toHaveBeenCalled();
    fireEvent.click(cancelButton);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Garage Board')).toBeTruthy();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('deletes only the confirmed board and refreshes the list and gym counts', async () => {
    const otherBoard = makeBoard({ uuid: 'board-2', name: 'Second Wall', gymUuid: GYM_UUID });
    const refreshedGym = { ...gym, boardCount: 1 };
    const onGymChange = vi.fn();
    stubRequests({ gymBoards: [linkedBoard, otherBoard], myBoards: [] });
    render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^delete$/i }))[0]);

    stubRequests({ gymBoards: [otherBoard], myBoards: [], gymDetails: refreshedGym });
    mockExecute.mockResolvedValueOnce({ deleteBoard: true });
    const confirmation = await screen.findByRole('dialog');
    fireEvent.click(within(confirmation).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(onGymChange).toHaveBeenCalledWith(refreshedGym));
    expect(mockExecute).toHaveBeenCalledExactlyOnceWith({ boardUuid: linkedBoard.uuid });
    expect(screen.queryByText('Garage Board')).toBeNull();
    expect(screen.getByText('Second Wall')).toBeTruthy();
    expect(mockShowMessage).toHaveBeenCalledWith('Board deleted', 'success');
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockRequest.mock.calls.filter(([operation]) => operation.includes('gymBoards'))).toHaveLength(2);
  });

  it('disables board edits, unlinks and deletes while deletion is pending', async () => {
    let resolveDelete!: (response: { deleteBoard: boolean }) => void;
    mockExecute.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    const otherBoard = makeBoard({ uuid: 'board-2', name: 'Second Wall', gymUuid: GYM_UUID, canEdit: true });
    stubRequests({ gymBoards: [{ ...linkedBoard, canEdit: true }, otherBoard], myBoards: [] });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^delete$/i }))[0]);
    const confirmation = await screen.findByRole('dialog');
    const confirmButton = within(confirmation).getByRole('button', { name: /^delete$/i });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    for (const button of screen.getAllByRole('button', { name: /^(delete|edit|unlink)$/i })) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    stubRequests({ gymBoards: [otherBoard], myBoards: [] });
    await act(async () => resolveDelete({ deleteBoard: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^delete$/i }).hasAttribute('disabled')).toBe(false));
  });

  it.each([null, { deleteBoard: false }])('retains the board and allows retry after response %j', async (response) => {
    const onGymChange = vi.fn();
    mockExecute.mockResolvedValueOnce(response);
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Garage Board')).toBeTruthy();
    expect(onGymChange).not.toHaveBeenCalled();
    expect(mockShowMessage).not.toHaveBeenCalledWith('Board deleted', 'success');
    expect(mockRequest.mock.calls.filter(([operation]) => operation.includes('gymBoards'))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    stubRequests({ gymBoards: [], myBoards: [] });
    mockExecute.mockResolvedValueOnce({ deleteBoard: true });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(screen.queryByText('Garage Board')).toBeNull());
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('closes the old account confirmation when the account changes', async () => {
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await screen.findByRole('dialog');

    mockSessionUserId.current = 'another-account';
    stubRequests({ gymBoards: [], myBoards: [] });
    rerender(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('ignores an old account deletion completing after the account changed', async () => {
    let resolveDelete!: (response: { deleteBoard: boolean }) => void;
    mockExecute.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    const onGymChange = vi.fn();
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(1));

    mockSessionUserId.current = 'another-account';
    stubRequests({ gymBoards: [], myBoards: [] });
    rerender(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    await act(async () => resolveDelete({ deleteBoard: true }));

    expect(onGymChange).not.toHaveBeenCalled();
    expect(mockShowMessage).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('ignores a gym count refresh completing after the account changed', async () => {
    let resolveGym!: (response: { gym: Gym }) => void;
    mockExecute.mockResolvedValueOnce({ deleteBoard: true });
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    const onGymChange = vi.fn();
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    mockRequest.mockImplementation(async (operation: string) => {
      if (operation.includes('query GetGym('))
        return new Promise((resolve) => {
          resolveGym = resolve;
        });
      return { gymBoards: [] };
    });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining('query GetGym('), { gymUuid: GYM_UUID }),
    );

    mockSessionUserId.current = 'another-account';
    stubRequests({ gymBoards: [], myBoards: [] });
    rerender(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    await act(async () => resolveGym({ gym }));

    expect(onGymChange).not.toHaveBeenCalled();
  });

  it('does not restore a deleted board when an older list request finishes late', async () => {
    let resolveStaleBoards!: (response: { gymBoards: UserBoard[] }) => void;
    stubRequests({ gymBoards: [linkedBoard], myBoards: [] });
    const onGymChange = vi.fn();
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    await screen.findByText('Garage Board');
    let listReadCount = 0;
    mockRequest.mockImplementation(async (operation: string) => {
      if (operation.includes('query GetGym(')) return { gym };
      listReadCount += 1;
      if (listReadCount === 1)
        return new Promise((resolve) => {
          resolveStaleBoards = resolve;
        });
      return { gymBoards: [] };
    });
    mockToken.current = 'refreshed-token';
    rerender(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    await waitFor(() => expect(listReadCount).toBe(1));

    mockExecute.mockResolvedValueOnce({ deleteBoard: true });
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(onGymChange).toHaveBeenCalled());
    await act(async () => resolveStaleBoards({ gymBoards: [linkedBoard] }));

    expect(screen.queryByText('Garage Board')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });
});

describe('GymBoardsTab — stray boards', () => {
  const editableGym = { ...gym, canEdit: true } as unknown as Gym;

  function makeStray(overrides: Partial<StrayBoard>): StrayBoard {
    return {
      uuid: 'stray-1',
      name: 'Nearby Tension',
      boardType: 'tension',
      angle: 40,
      currentGymUuid: null,
      currentGymName: null,
      distanceMeters: 42,
      reason: 'NEARBY',
      isLastBoardAtCurrentGym: false,
      ...overrides,
    };
  }

  it('lists stray candidates with their reason and the current listing', async () => {
    stubRequests({
      gymBoards: [],
      myBoards: [],
      strays: [
        makeStray({ uuid: 'stray-merged', name: 'Old Kilter', reason: 'MERGED_TWIN', currentGymName: 'Old Listing' }),
        makeStray({ uuid: 'stray-nearby', name: 'Nearby Tension', reason: 'NEARBY', distanceMeters: 42 }),
      ],
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    expect(await screen.findByText(/boards that might be yours/i)).toBeTruthy();
    expect(screen.getByText('Old Kilter')).toBeTruthy();
    expect(screen.getByText(/was on a merged listing/i)).toBeTruthy();
    expect(screen.getByText('Nearby Tension')).toBeTruthy();
    expect(screen.getByText(/42 m away/i)).toBeTruthy();
  });

  it('attaches a stray board and drops it from the list', async () => {
    stubRequests({
      gymBoards: [],
      myBoards: [],
      strays: [makeStray({ uuid: 'stray-nearby', name: 'Nearby Tension' })],
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    await screen.findByText('Nearby Tension');
    mockExecute.mockResolvedValueOnce({ attachBoardToGym: true });

    fireEvent.click(screen.getByRole('button', { name: /add to gym/i }));

    await waitFor(() =>
      expect(mockExecute).toHaveBeenCalledWith({
        input: {
          gymUuid: GYM_UUID,
          boardUuid: 'stray-nearby',
          expectedCurrentGymUuid: null,
          allowSourceGymMerge: false,
        },
      }),
    );
    await waitFor(() => expect(screen.queryByText('Nearby Tension')).toBeNull());
  });

  it('keeps the candidate when the attach mutation fails', async () => {
    stubRequests({
      gymBoards: [],
      myBoards: [],
      strays: [makeStray({ uuid: 'stray-nearby', name: 'Nearby Tension' })],
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    await screen.findByText('Nearby Tension');
    mockExecute.mockResolvedValueOnce(null); // useEntityMutation resolves null on failure

    fireEvent.click(screen.getByRole('button', { name: /add to gym/i }));

    await waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Nearby Tension')).toBeTruthy();
  });

  it('shows a climber-voice empty state when there are no strays', async () => {
    stubRequests({ gymBoards: [], myBoards: [], strays: [] });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    expect(await screen.findByText(/nothing loose right now/i)).toBeTruthy();
  });

  it('surfaces a load error with a retry when the strays query fails', async () => {
    // gymBoards resolves (empty) so the linked list settles; strayBoardsForGym rejects.
    mockRequest.mockImplementation(async (document: string) => {
      if (typeof document === 'string' && document.includes('strayBoardsForGym')) {
        throw new Error('network down');
      }
      if (typeof document === 'string' && document.includes('gymBoards')) {
        return { gymBoards: [] };
      }
      return { myBoards: { boards: [], totalCount: 0, hasMore: false } };
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    expect(await screen.findByText(/couldn't check for stray boards/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('asks before attaching the last board on a listing, and only then fires the mutation', async () => {
    stubRequests({
      gymBoards: [],
      myBoards: [],
      strays: [
        makeStray({
          uuid: 'stray-last',
          name: 'Lonely Kilter',
          currentGymUuid: 'other-gym',
          currentGymName: 'Auto Listing',
          isLastBoardAtCurrentGym: true,
        }),
      ],
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    await screen.findByText('Lonely Kilter');
    expect(screen.getByText(/last board on that listing/i)).toBeTruthy();
    mockExecute.mockResolvedValueOnce({ attachBoardToGym: true });

    fireEvent.click(screen.getByRole('button', { name: /add to gym/i }));

    // The confirm step must land before anything is written.
    expect(await screen.findByText(/this empties the other listing/i)).toBeTruthy();
    expect(screen.getByText(/"Auto Listing" has no other boards/i)).toBeTruthy();
    expect(mockExecute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /add and merge/i }));

    await waitFor(() =>
      expect(mockExecute).toHaveBeenCalledWith({
        input: {
          gymUuid: GYM_UUID,
          boardUuid: 'stray-last',
          expectedCurrentGymUuid: 'other-gym',
          allowSourceGymMerge: true,
        },
      }),
    );
  });

  it('leaves the board alone when the merge confirm is cancelled', async () => {
    stubRequests({
      gymBoards: [],
      myBoards: [],
      strays: [
        makeStray({
          uuid: 'stray-last',
          name: 'Lonely Kilter',
          currentGymUuid: 'other-gym',
          currentGymName: 'Auto Listing',
          isLastBoardAtCurrentGym: true,
        }),
      ],
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    await screen.findByText('Lonely Kilter');
    fireEvent.click(screen.getByRole('button', { name: /add to gym/i }));
    await screen.findByText(/this empties the other listing/i);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByText(/this empties the other listing/i)).toBeNull());
    expect(mockExecute).not.toHaveBeenCalled();
    expect(screen.getByText('Lonely Kilter')).toBeTruthy();
  });

  it('binds merge consent to the displayed source even when it currently has other boards', async () => {
    stubRequests({
      gymBoards: [],
      myBoards: [],
      strays: [
        makeStray({
          uuid: 'stray-nearby',
          name: 'Nearby Tension',
          currentGymUuid: 'other-gym',
          currentGymName: 'Auto Listing',
          isLastBoardAtCurrentGym: false,
        }),
      ],
    });
    render(<GymBoardsTab gym={editableGym} onGymChange={vi.fn()} />);

    await screen.findByText('Nearby Tension');
    expect(screen.queryByText(/last board on that listing/i)).toBeNull();
    mockExecute.mockResolvedValueOnce({ attachBoardToGym: true });

    fireEvent.click(screen.getByRole('button', { name: /add to gym/i }));

    expect(await screen.findByText(/move this board/i)).toBeTruthy();
    expect(mockExecute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /move board/i }));
    await waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(1));
    expect(mockExecute).toHaveBeenCalledWith({
      input: {
        gymUuid: GYM_UUID,
        boardUuid: 'stray-nearby',
        expectedCurrentGymUuid: 'other-gym',
        allowSourceGymMerge: true,
      },
    });
    expect(screen.queryByText(/this empties the other listing/i)).toBeNull();
  });

  it('does not render the strays section without gym edit access', async () => {
    const noEditGym = { ...gym, canEdit: false } as unknown as Gym;
    stubRequests({ gymBoards: [], myBoards: [], strays: [makeStray({})] });
    render(<GymBoardsTab gym={noEditGym} onGymChange={vi.fn()} />);

    await screen.findByText(/no boards linked yet/i);
    expect(screen.queryByText(/boards that might be yours/i)).toBeNull();
  });
});

describe('GymBoardsTab — Print poster', () => {
  const WALL_UUID = '0144249a-3a8c-47c2-8c1e-54c0c572fe02';

  it('links each board the poster page would print, and only those', async () => {
    stubRequests({
      gymBoards: [
        makeBoard({ uuid: 'led-public', slug: 'main-kilter', name: 'Main Kilter' }),
        makeBoard({ uuid: 'led-private', slug: 'private-kilter', name: 'Private Kilter', isPublic: false }),
        makeBoard({
          uuid: WALL_UUID,
          slug: 'back-spraywall',
          name: 'Back Spraywall',
          boardType: 'spray',
          isPublic: false,
          isUnlisted: true,
        }),
        makeBoard({
          uuid: 'spray-private',
          slug: 'secret-spraywall',
          name: 'Secret Spraywall',
          boardType: 'spray',
          isPublic: false,
        }),
      ],
      myBoards: [],
    });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    await screen.findByText('Main Kilter');

    const posterLinks = screen.getAllByRole('link', { name: /print poster/i }).map((link) => link.getAttribute('href'));
    // An unlisted Spraywall's link carries its own uuid, the capability its
    // share link carries; private boards and walls get no action at all.
    expect(posterLinks).toEqual(['/poster/b/main-kilter', `/poster/b/back-spraywall?wall=${WALL_UUID}`]);
  });
});

describe('GymBoardsTab — editing', () => {
  function editingRequests(detail: UserBoard) {
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('query GetBoard(')) return { board: detail };
      if (document.includes('gymBoards'))
        return { gymBoards: [makeBoard({ name: 'Partial list record', canEdit: true })] };
      return { strayBoardsForGym: [] };
    });
  }

  it('hides edit when the server denies board editing', async () => {
    stubRequests({ gymBoards: [makeBoard({ canEdit: false })], myBoards: [] });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    await screen.findByText('Garage Board');
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
  });

  it('fetches the complete board before mounting the editor', async () => {
    editingRequests(makeBoard({ name: 'Complete board', description: 'Full description', canEdit: true }));
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByText('Full description');
    expect((screen.getByLabelText('Draft name') as HTMLInputElement).value).toBe('Complete board');
    expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining('query GetBoard('), { boardUuid: 'board-1' });
  });

  it('preserves unsaved edits through a same-account token refresh', async () => {
    editingRequests(makeBoard({ name: 'Complete board', canEdit: true }));
    const onGymChange = vi.fn();
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(await screen.findByLabelText('Draft name'), { target: { value: 'Unsaved rename' } });
    mockToken.current = 'refreshed-token';
    rerender(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    await waitFor(() => expect((screen.getByLabelText('Draft name') as HTMLInputElement).value).toBe('Unsaved rename'));
    expect(mockRequest.mock.calls.filter(([document]) => document.includes('query GetBoard('))).toHaveLength(1);
  });

  it('removes the old account’s loaded board immediately when the account changes', async () => {
    editingRequests(makeBoard({ name: 'Owner private draft', canEdit: true }));
    const onGymChange = vi.fn();
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText('Draft name');
    mockRequest.mockImplementation(() => new Promise(() => {}));
    mockSessionUserId.current = 'another-account';
    rerender(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    expect(screen.queryByLabelText('Draft name')).toBeNull();
  });

  it('ignores an old account’s save completing after the account changed', async () => {
    editingRequests(makeBoard({ name: 'Private wall', canEdit: true }));
    const onGymChange = vi.fn();
    const { rerender } = render(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByLabelText('Draft name');
    const completeOldSave = mockEditorSaved.current!;
    mockRequest.mockImplementation(() => new Promise(() => {}));
    mockSessionUserId.current = 'another-account';
    rerender(<GymBoardsTab gym={gym} onGymChange={onGymChange} />);
    await act(async () => completeOldSave(makeBoard({ name: 'Old account result', canEdit: true })));
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText('Partial list record')).toBeNull();
    expect(screen.queryByLabelText('Draft name')).toBeNull();
  });

  it('refreshes the row and server content after a successful edit', async () => {
    let listReadCount = 0;
    const updatedBoard = makeBoard({ name: 'Renamed wall', canEdit: true });
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('query GetBoard(')) return { board: makeBoard({ canEdit: true }) };
      if (document.includes('gymBoards')) {
        listReadCount += 1;
        return { gymBoards: [listReadCount === 1 ? makeBoard({ canEdit: true }) : updatedBoard] };
      }
      return { strayBoardsForGym: [] };
    });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(await screen.findByLabelText('Draft name'), { target: { value: 'Renamed wall' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save editor' }));
    await screen.findByText('Renamed wall');
    expect(listReadCount).toBe(2);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('guards returning to the list when the editor reports unsaved changes', async () => {
    const onDirtyChange = vi.fn();
    editingRequests(makeBoard({ canEdit: true }));
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(await screen.findByLabelText('Draft name'), { target: { value: 'Unsaved rename' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'All boards' }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByLabelText('Draft name')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await screen.findByText('Partial list record');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores a board detail response arriving after the editor was closed', async () => {
    let resolveDetail!: (response: { board: UserBoard }) => void;
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('query GetBoard('))
        return new Promise<{ board: UserBoard }>((resolve) => {
          resolveDetail = resolve;
        });
      if (document.includes('gymBoards')) return { gymBoards: [makeBoard({ canEdit: true })] };
      return { strayBoardsForGym: [] };
    });
    render(<GymBoardsTab gym={gym} onGymChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'All boards' }));
    await act(async () => resolveDetail({ board: makeBoard({ canEdit: true }) }));
    expect(screen.queryByTestId('hydrated-editor')).toBeNull();
    expect(screen.getByText('Garage Board')).toBeTruthy();
  });
});

describe('VisibilityChip', () => {
  it('shows unlisted when both legacy visibility flags are true', () => {
    render(<VisibilityChip board={{ isPublic: true, isUnlisted: true }} />);
    expect(screen.getByText('Unlisted')).toBeTruthy();
    expect(screen.queryByText('Public')).toBeNull();
  });
});
