// @vitest-environment jsdom
//
// Editing a board used to flatten every server rejection to an inline string.
// After #4174 dropped the per-owner config unique index, `updateBoard` answers a
// config collision with a typed BOARD_DUPLICATE_CONFIG the user is meant to be
// able to override — so a gym reconfiguring one wall to match another of the
// owner's boards gets asked instead of blocked.
//
// The other half of the contract: when the editor is NOT the board's owner (a
// gym admin, a community moderator), the server strips the colliding board's
// identity out of the extensions. The prompt still has to work.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type AlertButton = { text: string; style?: string; onPress?: () => void };

const updateBoardMock = vi.hoisted(() => vi.fn());
const linkBoardToGymMock = vi.hoisted(() => vi.fn());
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const backMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const alertMock = vi.hoisted(() => vi.fn());
const buildUpdateInputMock = vi.hoisted(() => vi.fn());

// What each test varies: the gym on file, the gym the picker is showing, and
// whether the board being edited is also the active one.
const state = vi.hoisted(() => ({
  boardGymUuid: null as string | null,
  selectedGym: null as { uuid: string; name: string } | null,
  activeBoardUuid: null as string | null,
}));

const board = {
  uuid: 'board-uuid',
  boardType: 'moonboard',
  layoutId: 3,
  sizeId: 1,
  setIds: '5,6,7',
  name: 'Klimmuur MoonBoard',
  gymUuid: null,
  canEdit: true,
} as unknown as UserBoard;

/** A graphql-request ClientError carrying the server's duplicate rejection. */
function duplicateError(extensions: Record<string, unknown>) {
  return {
    response: {
      errors: [{ message: 'You already have this board at this location', extensions }],
    },
  };
}

const ownerDuplicate = duplicateError({
  code: 'BOARD_DUPLICATE_CONFIG',
  existingBoardUuid: 'sibling-uuid',
  existingBoardName: 'Garage MoonBoard',
  existingBoardSlug: 'garage-moonboard',
  existingBoardLocationName: 'My Garage',
});

/** What a gym admin or moderator sees: the code, and nothing that names a board. */
const strippedDuplicate = duplicateError({ code: 'BOARD_DUPLICATE_CONFIG' });

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: backMock }),
  useLocalSearchParams: () => ({ boardUuid: 'board-uuid' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useBoard: () => ({ data: { ...board, gymUuid: state.boardGymUuid }, isLoading: false }),
  useProfile: () => ({ data: { displayName: 'Marco' } }),
  useUpdateBoard: () => ({ mutateAsync: updateBoardMock }),
  useLinkBoardToGym: () => ({ mutateAsync: linkBoardToGymMock }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({
    data: state.activeBoardUuid ? ({ uuid: state.activeBoardUuid } as unknown as UserBoard) : null,
  }),
  useSetActiveBoard: () => setActiveBoardMock,
}));

vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));

// The builder has its own suite; here it only has to hand back a valid input so
// the screen's control flow is what's under test.
vi.mock('../../../src/components/board-discovery/use-board-builder', () => ({
  useBoardBuilder: () => ({
    boardName: 'moonboard',
    sizes: [],
    sizeId: 1,
    rawLayoutName: 'Standard',
    selectedGym: state.selectedGym,
    buildUpdateInput: buildUpdateInputMock,
  }),
}));

vi.mock('../../../src/components/board-discovery/board-builder-labels', () => ({
  formatDefaultBoardName: () => 'Default name',
}));

vi.mock('../../../src/components/board-discovery/BoardForm', () => ({
  BoardForm: ({ onSubmit, errorMessage }: { onSubmit: () => void; errorMessage?: string | null }) =>
    createElement('div', null, [
      createElement('button', { key: 'submit', type: 'button', onClick: onSubmit }, 'submit'),
      errorMessage ? createElement('span', { key: 'error', 'data-testid': 'error' }, errorMessage) : null,
    ]),
}));

vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/components/Button', () => ({ Button: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000' } }),
}));

vi.mock('@boardsesh/board-config', () => ({ toBoardName: (value: string) => value }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  // `src/theme/colors` resolves the iOS palette at import time.
  PlatformColor: (name: string) => name,
  Alert: { alert: (...args: unknown[]) => alertMock(...args) },
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

const { default: EditBoard } = await import('../edit');

/** The buttons handed to the last `Alert.alert` call. */
function alertButtons(): AlertButton[] {
  return alertMock.mock.calls.at(-1)?.[2] as AlertButton[];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.boardGymUuid = null;
  state.selectedGym = null;
  state.activeBoardUuid = null;
  buildUpdateInputMock.mockReturnValue({ boardUuid: 'board-uuid', name: 'Klimmuur MoonBoard' });
  updateBoardMock.mockResolvedValue({ uuid: 'board-uuid', name: 'Klimmuur MoonBoard' } as unknown as UserBoard);
});

describe('EditBoard', () => {
  it('passes the board on file so an unchanged config is left out of the input', async () => {
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(updateBoardMock).toHaveBeenCalledTimes(1));
    expect(buildUpdateInputMock).toHaveBeenCalledWith(
      'board-uuid',
      expect.objectContaining({ currentConfig: { layoutId: 3, sizeId: 1, setIds: '5,6,7' } }),
    );
    expect(updateBoardMock.mock.calls[0][0].allowDuplicateConfig).toBeUndefined();
  });

  it('asks instead of failing when the config collides with a sibling board', async () => {
    updateBoardMock.mockRejectedValueOnce(ownerDuplicate);
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    const [title, body] = alertMock.mock.calls[0];
    expect(title).toBe('mobile.edit.duplicate.title');
    // Both the name and the place are known here, so the body names both.
    expect(body).toContain('mobile.edit.duplicate.bodyWithLocation');
    expect(body).toContain('Garage MoonBoard');
    expect(body).toContain('My Garage');
    expect(trackMock).toHaveBeenCalledWith(
      'Board Duplicate Prompted',
      expect.objectContaining({ source: 'mobile_edit', boardType: 'moonboard' }),
    );
    // Not a dead end and not a navigation: the edit is still on screen.
    expect(backMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('names only the board when the server withheld its location', async () => {
    updateBoardMock.mockRejectedValueOnce(
      duplicateError({
        code: 'BOARD_DUPLICATE_CONFIG',
        existingBoardUuid: 'sibling-uuid',
        existingBoardName: 'Garage MoonBoard',
      }),
    );
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    const body = alertMock.mock.calls[0][1] as string;
    expect(body).toContain('mobile.edit.duplicate.body:');
    expect(body).toContain('Garage MoonBoard');
  });

  it('falls back to a generic body when the server stripped the board identity', async () => {
    // A gym admin editing someone else's board never learns which board it hit.
    updateBoardMock.mockRejectedValueOnce(strippedDuplicate);
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    expect(alertMock.mock.calls[0][1]).toBe('mobile.edit.duplicate.bodyGeneric');
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('resends with allowDuplicateConfig when the user saves anyway', async () => {
    updateBoardMock.mockRejectedValueOnce(ownerDuplicate);
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    const buttons = alertButtons();
    expect(buttons[0]).toMatchObject({ text: 'mobile.edit.duplicate.keepEditing', style: 'cancel' });

    buttons[1].onPress?.();

    await waitFor(() => expect(updateBoardMock).toHaveBeenCalledTimes(2));
    expect(updateBoardMock.mock.calls[1][0].allowDuplicateConfig).toBe(true);
    await waitFor(() => expect(backMock).toHaveBeenCalled());
  });

  it('leaves the edit untouched when the user keeps editing', async () => {
    updateBoardMock.mockRejectedValueOnce(ownerDuplicate);
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    alertButtons()[0].onPress?.();

    expect(updateBoardMock).toHaveBeenCalledTimes(1);
    expect(backMock).not.toHaveBeenCalled();
  });

  it('still reports a non-duplicate failure inline', async () => {
    updateBoardMock.mockRejectedValueOnce(new Error('boom'));
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(alertMock).not.toHaveBeenCalled();
    expect(backMock).not.toHaveBeenCalled();
  });

  // `linkBoardToGym` runs after `updateBoard` and invalidates `['board']` /
  // `['myBoards']`, never the `['activeBoard']` snapshot (staleTime: Infinity).
  // Re-persisting the `updateBoard` response verbatim would keep the stored copy
  // on the old venue across relaunches — the play drawer and every analytics
  // event stamped from it would still name the gym the user just left.
  it('persists the gym the board was just linked to onto the active board', async () => {
    state.activeBoardUuid = 'board-uuid';
    state.selectedGym = { uuid: 'gym-uuid', name: 'Klimmuur Centrum' };
    // The pre-link answer from `updateBoard`: no gym yet.
    updateBoardMock.mockResolvedValueOnce({
      uuid: 'board-uuid',
      name: 'Klimmuur MoonBoard',
      gymUuid: null,
      gymName: null,
    } as unknown as UserBoard);

    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(setActiveBoardMock).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'board-uuid', gymUuid: 'gym-uuid', gymName: 'Klimmuur Centrum' }),
    );
  });

  it('clears the gym on the stored copy when the board is unlinked', async () => {
    state.activeBoardUuid = 'board-uuid';
    state.boardGymUuid = 'gym-uuid';
    state.selectedGym = null;
    updateBoardMock.mockResolvedValueOnce({
      uuid: 'board-uuid',
      name: 'Klimmuur MoonBoard',
      gymUuid: 'gym-uuid',
      gymName: 'Klimmuur Centrum',
    } as unknown as UserBoard);

    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(linkBoardToGymMock).toHaveBeenCalledWith({ boardUuid: 'board-uuid', gymUuid: null });
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ gymUuid: null, gymName: null }));
  });

  it('keeps the server gym when the link mutation was rejected', async () => {
    // Too far from a gym the user doesn't run: the rest of the edit saved, so
    // the stored copy is still refreshed — with the gym the server still holds,
    // not the one the picker was showing.
    state.activeBoardUuid = 'board-uuid';
    state.selectedGym = { uuid: 'gym-uuid', name: 'Klimmuur Centrum' };
    linkBoardToGymMock.mockRejectedValueOnce(new Error('not authorized'));
    updateBoardMock.mockResolvedValueOnce({
      uuid: 'board-uuid',
      name: 'Klimmuur MoonBoard',
      gymUuid: null,
      gymName: null,
    } as unknown as UserBoard);

    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ gymUuid: null, gymName: null }));
    expect(backMock).not.toHaveBeenCalled();
  });

  it('leaves the stored copy alone when the edited board is not the active one', async () => {
    state.activeBoardUuid = 'another-board';
    state.selectedGym = { uuid: 'gym-uuid', name: 'Klimmuur Centrum' };

    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(backMock).toHaveBeenCalled());
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  it('names the account cap instead of echoing the server message', async () => {
    // Restoring a soft-deleted board adds a live board, so an edit can hit the
    // same 50-board cap a create does. Same actionable copy as create — not
    // the raw server message, which never explains the fix.
    updateBoardMock.mockRejectedValueOnce({
      response: {
        errors: [
          {
            message: 'You have reached the maximum of 50 boards for one account',
            extensions: { code: 'BOARD_LIMIT_REACHED', maxBoards: 50 },
          },
        ],
      },
    });
    render(createElement(EditBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error').textContent).toBe('mobile.create.limitReached');
    expect(alertMock).not.toHaveBeenCalled();
    expect(backMock).not.toHaveBeenCalled();
  });
});
