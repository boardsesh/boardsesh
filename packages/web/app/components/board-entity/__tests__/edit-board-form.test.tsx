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

// Same collision, but the sibling board has no location on file — the dialog
// falls back to the name-only body instead of naming a place.
const ownerDuplicateNoLocation = duplicateError({
  code: 'BOARD_DUPLICATE_CONFIG',
  existingBoardUuid: 'sibling-uuid',
  existingBoardName: 'Garage Kilter',
  existingBoardSlug: 'garage-kilter',
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

  it('names both the colliding board and its location instead of a failure toast', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(ownerDuplicate, 'You already have this board at this location');
    });

    expect(
      screen.getByText(
        'This change makes the board match "Garage Kilter" at My Garage — same layout, size and hold sets.',
      ),
    ).toBeTruthy();
    expect(mockShowMessage).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'Board Duplicate Prompted',
      expect.objectContaining({ source: 'web_edit_drawer', boardType: 'kilter' }),
    );
  });

  it('falls back to the name-only body when the colliding board has no location on file', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(ownerDuplicateNoLocation, null);
    });

    expect(
      screen.getByText('This change makes the board match "Garage Kilter" — same layout, size and hold sets.'),
    ).toBeTruthy();
    expect(mockShowMessage).not.toHaveBeenCalled();
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

  it('keeps the specific body on screen through the close transition instead of flashing the generic one', async () => {
    // MUI's Dialog fade-out re-renders the still-mounted body while closing, so
    // clearing the duplicate data on the same tick as the click used to swap
    // the specific copy for the generic fallback for the ~300ms of the
    // transition. The data now only clears on `onExited`, once the transition
    // has actually finished, so it has to still be there right after the click.
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(ownerDuplicate, null);
    });
    expect(
      screen.getByText(
        'This change makes the board match "Garage Kilter" at My Garage — same layout, size and hold sets.',
      ),
    ).toBeTruthy();

    await act(async () => {
      screen.getByText('Cancel').click();
    });

    // The transition's `onExited` hasn't fired yet (it needs a real transition
    // end, not just the click), so the specific body should still be showing —
    // not the generic fallback the bug flashed instead.
    expect(
      screen.getByText(
        'This change makes the board match "Garage Kilter" at My Garage — same layout, size and hold sets.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('This change matches a board setup the owner already has.')).toBeNull();
  });

  it('toasts the account-cap copy instead of the dialog when restoring a soft-deleted board hits the limit', async () => {
    // Saving a soft-deleted board restores it, which can land the owner back at
    // the 50-board cap. Same copy as board creation — retrying never clears it,
    // deleting a board does.
    const onError = renderAndGetOnError();

    await act(async () => {
      onError(duplicateError({ code: 'BOARD_LIMIT_REACHED' }), null);
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      "You've reached the maximum number of boards for one account. Delete a board you no longer use to add another.",
      'error',
    );
    expect(screen.queryByText('Save anyway')).toBeNull();
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
