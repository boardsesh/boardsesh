import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, act, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import EditBoardForm from '../edit-board-form';

// Editing a board reported the duplicate-config guard as a flat "Failed to
// update board" with no way past it. Since #4174 an owner can hold the same wall
// twice (home and gym) and `updateBoard` takes `allowDuplicateConfig`, so the
// refusal is a question now.
//
// The other half: `updateBoard` is reachable by gym admins and community
// moderators, and the server strips the colliding board's identity for them —
// so the dialog also has to render with no board to name.

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// vi.hoisted: the component is imported at the top of this file, so these mock
// factories run before a plain `const` below would have initialised. (CI also
// typechecks test files, so no spread-wrapped vi.fn.)
const mockShowMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track: mockTrack }));

const mockExecute = vi.hoisted(() => vi.fn());
const errorHolder = vi.hoisted(() => ({
  onError: null as ((error: unknown, serverMessage: string | null) => void) | null,
}));
vi.mock('@/app/hooks/use-entity-mutation', () => ({
  useEntityMutation: (_mutation: unknown, opts: { onError?: (e: unknown, s: string | null) => void }) => {
    errorHolder.onError = opts.onError ?? null;
    return { execute: mockExecute };
  },
}));

const SUBMIT_VALUES = {
  name: 'Home Wall',
  slug: 'home-wall',
  description: '',
  locationName: 'Garage',
  isPublic: true,
  isUnlisted: false,
  hideLocation: false,
  isOwned: true,
  angle: 40,
  layoutId: 1,
  sizeId: 2,
  setIds: 'set-1',
};
vi.mock('../board-form', () => ({
  default: ({ onSubmit }: { onSubmit: (values: typeof SUBMIT_VALUES) => void }) =>
    React.createElement(
      'button',
      { 'data-testid': 'board-form', type: 'button', onClick: () => onSubmit(SUBMIT_VALUES) },
      'submit form',
    ),
}));

vi.mock('@boardsesh/graphql/operations', () => ({ UPDATE_BOARD: 'UPDATE_BOARD' }));

const board = {
  uuid: 'board-uuid',
  boardType: 'kilter',
  slug: 'home-wall',
  name: 'Home Wall',
  description: null,
  locationName: 'Garage',
  latitude: null,
  longitude: null,
  isPublic: true,
  isUnlisted: false,
  hideLocation: false,
  isOwned: true,
  angle: 40,
  isAngleAdjustable: true,
  layoutId: 1,
  sizeId: 2,
  setIds: 'set-1',
  serialNumber: null,
  canEdit: true,
} as unknown as import('@boardsesh/shared-schema').UserBoard;

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
  existingBoardName: 'Garage Kilter',
  existingBoardSlug: 'garage-kilter',
  existingBoardLocationName: 'My Garage',
});

function renderAndGetOnError() {
  render(React.createElement(EditBoardForm, { board }));
  return errorHolder.onError!;
}

describe('EditBoardForm — duplicate config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorHolder.onError = null;
  });

  it('sends no confirmation flag on a first save', async () => {
    render(React.createElement(EditBoardForm, { board }));

    await act(async () => {
      screen.getByTestId('board-form').click();
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0].input.allowDuplicateConfig).toBeUndefined();
  });

  it('opens a dialog naming the colliding board instead of a failure toast', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(ownerDuplicate, 'You already have this board at this location');
    });

    expect(screen.getByText(/Garage Kilter/)).toBeTruthy();
    expect(mockShowMessage).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'Board Duplicate Prompted',
      expect.objectContaining({ source: 'web_edit_drawer', boardType: 'kilter' }),
    );
  });

  it('falls back to a generic body when the server stripped the board identity', async () => {
    // What a gym admin or moderator gets: the code, and nothing that names a
    // board they may have no read access to.
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(duplicateError({ code: 'BOARD_DUPLICATE_CONFIG' }), null);
    });

    expect(screen.getByText('This change matches a board setup the owner already has.')).toBeTruthy();
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('replays the edit with allowDuplicateConfig when the user saves anyway', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      screen.getByTestId('board-form').click();
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);

    await act(async () => {
      onError(ownerDuplicate, null);
    });

    await act(async () => {
      screen.getByText('Save anyway').click();
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    // Same edit, now with the user's confirmation attached.
    expect(mockExecute.mock.calls[1][0].input).toMatchObject({
      boardUuid: 'board-uuid',
      name: 'Home Wall',
      allowDuplicateConfig: true,
    });
  });

  it('guards against a double-click on "Save anyway" firing two mutations', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      screen.getByTestId('board-form').click();
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);

    await act(async () => {
      onError(ownerDuplicate, null);
    });

    // Two rapid clicks, fired before either retry has resolved — the
    // in-flight guard should let only the first one through.
    await act(async () => {
      const saveAnyway = screen.getByText('Save anyway');
      saveAnyway.click();
      saveAnyway.click();
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('leaves the edit alone when the user cancels', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      screen.getByTestId('board-form').click();
    });

    await act(async () => {
      onError(ownerDuplicate, null);
    });

    await act(async () => {
      screen.getByText('Cancel').click();
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('still reports a non-duplicate failure through the snackbar', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      onError({ response: { errors: [{ extensions: { code: 'RATE_LIMITED' } }] } }, 'slow down');
    });

    expect(mockShowMessage).toHaveBeenCalledWith('slow down', 'error');
    expect(screen.queryByText('Save anyway')).toBeNull();
  });

  it('falls back to the i18n error key when there is no server message', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(new Error('boom'), null);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Failed to update board', 'error');
  });
});
