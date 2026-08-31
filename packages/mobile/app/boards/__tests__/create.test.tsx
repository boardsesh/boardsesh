// @vitest-environment jsdom
//
// #4166. Creating a board silently did nothing: `handleCreate` looked for an
// already-owned board with the same (type, layout, size, sets) and, on a match,
// skipped the mutation entirely — discarding the filled-in form, activating the
// OLD board and dismissing on the happy path. A climber adding a second
// MoonBoard 2024 at a new gym got switched to their existing one, with no
// message either way.
//
// The contract now: every submit reaches the server, and a duplicate is the
// user's decision, not the client's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };

const createBoardMock = vi.hoisted(() => vi.fn());
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const adoptFoundBoardMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const markOnboardingSeenMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setBoardRevealTipPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const followBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fetchBoardsBySerialNumbersMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const fetchBoardByUuidMock = vi.hoisted(() => vi.fn());
const dismissToMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
}));

const existingBoard = {
  uuid: 'existing-uuid',
  name: 'Boulder Space - MoonBoard 2024 Standard',
} as unknown as UserBoard;

/** A graphql-request ClientError carrying the server's duplicate-SERIAL rejection. */
function serialExistsError() {
  return {
    response: {
      errors: [
        {
          message: 'That serial is already registered to another board',
          extensions: {
            code: 'BOARD_SERIAL_EXISTS',
            boardUuid: 'existing-uuid',
            slug: 'other-wall',
            name: 'Other wall',
          },
        },
      ],
    },
  };
}

/** A graphql-request ClientError carrying the server's duplicate-CONFIG rejection. */
function duplicateError() {
  return {
    response: {
      errors: [
        {
          message: 'You already have this board at this location',
          extensions: {
            code: 'BOARD_DUPLICATE_CONFIG',
            existingBoardUuid: 'existing-uuid',
            existingBoardName: 'Boulder Space - MoonBoard 2024 Standard',
            existingBoardSlug: 'boulder-space-moonboard',
            existingBoardLocationName: 'Boulder Space',
          },
        },
      ],
    },
  };
}

vi.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: dismissToMock }),
  useLocalSearchParams: () => state.params,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useCreateBoard: () => ({ mutateAsync: createBoardMock }),
  useFollowBoard: () => ({ mutateAsync: followBoardMock }),
  useProfile: () => ({ data: { displayName: 'Marco' } }),
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

vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));

// The builder is exercised in its own suite; here it just has to produce a valid
// input so the screen's control flow is what's under test.
vi.mock('../../../src/components/board-discovery/use-board-builder', () => ({
  useBoardBuilder: () => ({
    boardName: 'moonboard',
    sizes: [],
    sizeId: 1,
    rawLayoutName: 'Standard',
    coords: null,
    selectedGym: null,
    buildCreateInput: () => ({
      boardType: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: '5,6,7,8,9,10',
      name: 'Klimmuur MoonBoard',
      angle: 25,
      locationName: 'Klimmuur',
    }),
  }),
}));

vi.mock('../../../src/components/board-discovery/board-builder-labels', () => ({
  formatDefaultBoardName: () => 'Default name',
}));

// Stand-ins that expose just enough DOM to drive the flow.
vi.mock('../../../src/components/board-discovery/BoardForm', () => ({
  BoardForm: ({ onSubmit, errorMessage }: { onSubmit: () => void; errorMessage?: string | null }) =>
    createElement('div', null, [
      createElement('button', { key: 'submit', type: 'button', onClick: onSubmit }, 'submit'),
      errorMessage ? createElement('span', { key: 'error', 'data-testid': 'error' }, errorMessage) : null,
    ]),
}));

vi.mock('../../../src/components/board-discovery/BoardDuplicatePromptSheet', () => ({
  BoardDuplicatePromptSheet: ({
    duplicate,
    onUseExisting,
    onAddAnother,
  }: {
    duplicate: { boardName: string };
    onUseExisting: () => void;
    onAddAnother: () => void;
  }) =>
    createElement('div', { 'data-testid': 'duplicate-prompt' }, [
      createElement('span', { key: 'name' }, duplicate.boardName),
      createElement('button', { key: 'use', type: 'button', onClick: onUseExisting }, 'use existing'),
      createElement('button', { key: 'add', type: 'button', onClick: onAddAnother }, 'add another'),
    ]),
}));

vi.mock('../../../src/components/board-discovery/SerialReuseConfirmSheet', () => ({
  SerialReuseConfirmSheet: ({
    visible,
    onCreateAnyway,
    onUseExisting,
  }: {
    visible: boolean;
    onCreateAnyway: () => void;
    onUseExisting: () => void;
  }) =>
    visible
      ? createElement('div', { 'data-testid': 'serial-prompt' }, [
          createElement('button', { key: 'anyway', type: 'button', onClick: onCreateAnyway }, 'create anyway'),
          createElement('button', { key: 'existing', type: 'button', onClick: onUseExisting }, 'use that wall'),
        ])
      : null,
}));

vi.mock('@boardsesh/board-config', () => ({ toBoardName: (value: string) => value }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

const { default: CreateBoard } = await import('../create');

beforeEach(() => {
  vi.clearAllMocks();
  state.params = {};
  createBoardMock.mockResolvedValue({ uuid: 'new-uuid', name: 'Klimmuur MoonBoard' } as unknown as UserBoard);
  fetchBoardByUuidMock.mockResolvedValue(existingBoard);
  fetchBoardsBySerialNumbersMock.mockResolvedValue([]);
  followBoardMock.mockResolvedValue(undefined);
});

describe('CreateBoard', () => {
  it('always calls the server, even when the config matches an owned board', async () => {
    // The #4166 repro: previously an owned config match short-circuited here and
    // the mutation was never reached.
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    // The user's typed values reach the server rather than being discarded.
    expect(createBoardMock.mock.calls[0][0]).toMatchObject({
      name: 'Klimmuur MoonBoard',
      angle: 25,
      locationName: 'Klimmuur',
    });
    expect(createBoardMock.mock.calls[0][0].allowDuplicateConfig).toBeUndefined();
  });

  it('activates the new board and dismisses on success', async () => {
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() =>
      expect(setActiveBoardMock).toHaveBeenCalledWith({ uuid: 'new-uuid', name: 'Klimmuur MoonBoard' }),
    );
    expect(dismissToMock).toHaveBeenCalled();
  });

  it('still calls the server when seeded from a Popular config', async () => {
    // The seeded path used to keep a silent auto-activate; it does not any more.
    state.params = {
      seedBoardName: 'moonboard',
      seedLayoutId: '3',
      seedSizeId: '1',
      seedSetIds: '5,6,7,8,9,10',
    };
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
  });

  it('prompts instead of navigating when the server reports a duplicate', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    expect(screen.getByText('Boulder Space - MoonBoard 2024 Standard')).toBeTruthy();
    // Critically: no silent switch and no dismissal.
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(dismissToMock).not.toHaveBeenCalled();
  });

  it('retries with allowDuplicateConfig when the user says it is a different wall', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('add another'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].allowDuplicateConfig).toBe(true);
    // Saying "this is a different wall" answers the CONFIG guard and nothing
    // else. The serial guard is a separate question with a separate prompt.
    expect(createBoardMock.mock.calls[1][0].allowDuplicateSerial).toBeUndefined();
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('chains the two guards, carrying both confirmations onto the retry', async () => {
    // The serial guard and the config guard ask different questions about the
    // same create, and the server can raise them one after the other. Answering
    // the second must not silently drop the answer to the first — otherwise the
    // retry re-trips the serial guard and the climber loops forever.
    createBoardMock.mockRejectedValueOnce(serialExistsError()).mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('serial-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('create anyway'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].allowDuplicateSerial).toBe(true);
    expect(createBoardMock.mock.calls[1][0].allowDuplicateConfig).toBeUndefined();

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('add another'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(3));
    expect(createBoardMock.mock.calls[2][0]).toMatchObject({
      allowDuplicateSerial: true,
      allowDuplicateConfig: true,
    });
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('switches to the existing board when the user picks it', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('use existing'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(existingBoard));
    expect(fetchBoardByUuidMock).toHaveBeenCalledWith('existing-uuid');
    expect(createBoardMock).toHaveBeenCalledTimes(1);
  });

  it('names the account cap instead of echoing the server message', async () => {
    // 'board_limit' has to stay out of the 'exception' bucket: retrying will
    // never clear it, and the way out (delete a board) belongs in our own copy.
    createBoardMock.mockRejectedValueOnce({
      response: {
        errors: [
          {
            message: 'You have reached the maximum of 50 boards for one account',
            extensions: { code: 'BOARD_LIMIT_REACHED', maxBoards: 50 },
          },
        ],
      },
    });
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error').textContent).toBe('mobile.create.limitReached');
    expect(trackMock).toHaveBeenCalledWith(
      'Board Create Failed',
      expect.objectContaining({ error_reason: 'board_limit' }),
    );
    expect(dismissToMock).not.toHaveBeenCalled();
  });

  it('shows a non-duplicate failure inline rather than as an invisible toast', async () => {
    // This screen is a `presentation: 'modal'` route, and the toast overlay
    // renders behind those — a toast here would never be seen.
    createBoardMock.mockRejectedValueOnce(new Error('boom'));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(dismissToMock).not.toHaveBeenCalled();
  });
});
