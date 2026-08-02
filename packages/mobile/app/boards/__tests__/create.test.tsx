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

/** A graphql-request ClientError carrying the server's duplicate rejection. */
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
  useProfile: () => ({ data: { displayName: 'Marco' } }),
  fetchBoardByUuid: fetchBoardByUuidMock,
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useSetActiveBoard: () => setActiveBoardMock,
}));

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
