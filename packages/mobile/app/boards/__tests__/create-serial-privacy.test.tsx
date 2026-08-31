// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';

const routerMock = vi.hoisted(() => ({ dismissTo: vi.fn() }));
const trackMock = vi.hoisted(() => vi.fn());
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const adoptFoundBoardMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const markOnboardingSeenMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setBoardRevealTipPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const createBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const followBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fetchBoardByUuidMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const fetchBoardsBySerialNumbersMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

const createInput: CreateBoardInput = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  name: 'My wall',
  serialNumber: 'PRIVATE-123',
};

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'foreign-board',
    slug: 'foreign-board',
    ownerId: 'other-user',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Secret training room',
    isPublic: true,
    canEdit: false,
    ...overrides,
  } as unknown as UserBoard;
}

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => ({}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useMyBoards: () => ({ data: { boards: [] } }),
  useCreateBoard: () => ({ mutateAsync: createBoardMock }),
  useFollowBoard: () => ({ mutateAsync: followBoardMock }),
  useProfile: () => ({ data: { displayName: 'Climber' } }),
  fetchBoardByUuid: fetchBoardByUuidMock,
  fetchBoardsBySerialNumbers: fetchBoardsBySerialNumbersMock,
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useSetActiveBoard: () => setActiveBoardMock,
}));

// `useActivateBoard` is the real bind sequence now (issue #4961): the builder no
// longer has its own shorter version, which is why creating a board from
// onboarding used to fire no activation event. Its collaborators are stubbed so
// the sequence itself stays under test.
vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => adoptFoundBoardMock,
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: showToastMock }) }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  markOnboardingSeen: markOnboardingSeenMock,
  setBoardRevealTipPending: setBoardRevealTipPendingMock,
}));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));

vi.mock('@boardsesh/board-config', () => ({ toBoardName: (value: string) => value }));

vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/boards/board-return-to', () => ({ resolveBoardReturnTo: () => '/boards' }));

vi.mock('../../../src/components/board-discovery/use-board-builder', () => ({
  useBoardBuilder: () => ({
    boardName: 'kilter',
    rawLayoutName: 'Original',
    sizeId: 10,
    sizes: [{ id: 10, name: '12 x 12' }],
    buildCreateInput: () => createInput,
  }),
}));

vi.mock('../../../src/components/board-discovery/board-builder-labels', () => ({
  formatDefaultBoardName: () => 'My wall',
}));

vi.mock('../../../src/components/board-discovery/BoardForm', () => ({
  BoardForm: ({ onSubmit, errorMessage }: { onSubmit: () => void; errorMessage?: string | null }) =>
    createElement('div', null, [
      createElement('button', { key: 'submit', type: 'button', onClick: onSubmit }, 'submit board'),
      errorMessage ? createElement('span', { key: 'error', 'data-testid': 'error' }, errorMessage) : null,
    ]),
}));

vi.mock('../../../src/components/board-discovery/BoardDuplicatePromptSheet', () => ({
  BoardDuplicatePromptSheet: () => createElement('div', { 'data-testid': 'duplicate-prompt' }),
}));

vi.mock('../../../src/components/board-discovery/SerialReuseConfirmSheet', () => ({
  SerialReuseConfirmSheet: ({
    visible,
    board: existingBoard,
    onUseExisting,
  }: {
    visible: boolean;
    board: UserBoard | null;
    onUseExisting: () => void;
  }) =>
    visible
      ? createElement(
          'div',
          null,
          createElement('span', null, existingBoard ? existingBoard.name : 'private serial conflict'),
          existingBoard ? createElement('button', { type: 'button', onClick: onUseExisting }, 'use existing') : null,
        )
      : null,
}));

const { default: CreateBoard } = await import('../create');

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBoardMock.mockResolvedValue(undefined);
  createBoardMock.mockResolvedValue({});
  followBoardMock.mockResolvedValue(undefined);
  fetchBoardByUuidMock.mockResolvedValue(null);
  fetchBoardsBySerialNumbersMock.mockResolvedValue([]);
});

describe('create-board serial reuse privacy', () => {
  it('turns a private foreign match into an identity-free conflict', async () => {
    fetchBoardsBySerialNumbersMock.mockResolvedValue([
      board({
        isPublic: false,
        name: 'Secret training room',
        locationName: 'Private address',
        ownerId: 'private-owner',
      }),
    ]);

    render(createElement(CreateBoard));
    fireEvent.click(screen.getByRole('button', { name: 'submit board' }));

    expect(await screen.findByText('private serial conflict')).toBeTruthy();
    expect(screen.queryByText('Secret training room')).toBeNull();
    expect(screen.queryByText('Private address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'use existing' })).toBeNull();
    expect(createBoardMock).not.toHaveBeenCalled();
  });

  it('keeps the create-error fallback identity-free when the board turns private', async () => {
    createBoardMock.mockRejectedValue({
      response: {
        errors: [
          {
            extensions: {
              code: 'BOARD_SERIAL_EXISTS',
              boardUuid: 'foreign-board',
              slug: 'public-wall',
              name: 'Public wall',
            },
          },
        ],
      },
    });
    fetchBoardByUuidMock.mockResolvedValue(
      board({
        isPublic: false,
        name: 'Secret training room',
        locationName: 'Private address',
        ownerId: 'private-owner',
      }),
    );

    render(createElement(CreateBoard));
    fireEvent.click(screen.getByRole('button', { name: 'submit board' }));

    expect(await screen.findByText('private serial conflict')).toBeTruthy();
    expect(fetchBoardByUuidMock).toHaveBeenCalledWith('foreign-board');
    expect(screen.queryByText('Secret training room')).toBeNull();
    expect(screen.queryByText('Private address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'use existing' })).toBeNull();
  });

  it('does not activate a public foreign board when following it fails', async () => {
    fetchBoardsBySerialNumbersMock.mockResolvedValue([board({ isPublic: true, name: 'Public wall' })]);
    followBoardMock.mockRejectedValue(new Error('network unavailable'));

    render(createElement(CreateBoard));
    fireEvent.click(screen.getByRole('button', { name: 'submit board' }));
    fireEvent.click(await screen.findByRole('button', { name: 'use existing' }));

    await waitFor(() => expect(followBoardMock).toHaveBeenCalledTimes(1));
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
    // Inline, not a toast: this screen is a `presentation: 'modal'` route and
    // the toast overlay renders behind it (#4166).
    expect(await screen.findByTestId('error')).toBeTruthy();
    expect(screen.getByTestId('error').textContent).toBe('mobile.create.createError');
  });
});
