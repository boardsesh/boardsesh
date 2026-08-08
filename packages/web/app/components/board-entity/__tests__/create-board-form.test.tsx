import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, act, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import CreateBoardForm from '../create-board-form';

// #4166. This used to look the user's boards up on EVERY create failure and call
// anything with a matching config a duplicate — so a rate-limit or auth failure
// reported itself as a duplicate whenever such a board happened to exist. The
// server now says so explicitly with a BOARD_DUPLICATE_CONFIG code carrying the
// existing board's identity, so the 20-page myBoards scan is gone and the branch
// keys off the code alone.

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// vi.hoisted: the component is imported at the top of this file, which runs
// these mock factories before a plain `const` on the line below would have
// initialised. (CI also typechecks test files, so no spread-wrapped vi.fn.)
const mockShowMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: mockPush }),
}));

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track: mockTrack }));

const mockExecute = vi.hoisted(() => vi.fn());
const errorHolder = vi.hoisted(() => ({
  onError: null as ((error: unknown, serverMessage: string | null) => Promise<void>) | null,
}));
vi.mock('@/app/hooks/use-entity-mutation', () => ({
  useEntityMutation: (_mutation: unknown, opts: { onError?: (e: unknown, s: string | null) => Promise<void> }) => {
    errorHolder.onError = opts.onError ?? null;
    return { execute: mockExecute };
  },
}));

// Exposes onSubmit so a test can drive a real submit — "add it anyway" replays
// the values from the attempt that was refused, so it only means anything after
// one.
const SUBMIT_VALUES = {
  name: 'Home Wall',
  description: '',
  locationName: 'Garage',
  isPublic: true,
  isUnlisted: false,
  hideLocation: false,
  isOwned: true,
  angle: 40,
};
vi.mock('../board-form', () => ({
  default: ({ onSubmit }: { onSubmit: (values: typeof SUBMIT_VALUES) => void }) =>
    React.createElement(
      'button',
      { 'data-testid': 'board-form', type: 'button', onClick: () => onSubmit(SUBMIT_VALUES) },
      'submit form',
    ),
}));

vi.mock('@boardsesh/graphql/operations', () => ({ CREATE_BOARD: 'CREATE_BOARD' }));

const defaultProps = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: 'set-1',
  defaultAngle: 40,
};

/** A graphql-request ClientError carrying the server's duplicate rejection. */
function duplicateError(overrides: Record<string, unknown> = {}) {
  return {
    response: {
      errors: [
        {
          message: 'You already have this board at this location',
          extensions: {
            code: 'BOARD_DUPLICATE_CONFIG',
            existingBoardUuid: 'existing-uuid',
            existingBoardName: 'Home Wall',
            existingBoardSlug: 'home-wall',
            existingBoardLocationName: 'Garage',
            ...overrides,
          },
        },
      ],
    },
  };
}

function renderAndGetOnError(props = defaultProps) {
  render(React.createElement(CreateBoardForm, props));
  return errorHolder.onError!;
}

describe('CreateBoardForm — handleCreateError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorHolder.onError = null;
  });

  it('opens the duplicate dialog naming the existing board', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      await onError(duplicateError(), 'You already have this board at this location');
    });

    expect(screen.getByText(/Home Wall/)).toBeTruthy();
    // The dialog replaces the snackbar entirely: this needs three outcomes and
    // the snackbar only has one action slot.
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('offers "add it anyway", which retries with allowDuplicateConfig', async () => {
    const onError = renderAndGetOnError();

    // A real submit first: execute resolves undefined (the mutation hook swallows
    // the failure and routes it to onError), which is what the server refusing a
    // duplicate looks like from here.
    await act(async () => {
      screen.getByTestId('board-form').click();
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0].input.allowDuplicateConfig).toBeUndefined();

    await act(async () => {
      await onError(duplicateError(), null);
    });

    await act(async () => {
      screen.getByText('Add it anyway').click();
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    // Same values, now with the user's confirmation attached.
    expect(mockExecute.mock.calls[1][0].input).toMatchObject({
      name: 'Home Wall',
      locationName: 'Garage',
      allowDuplicateConfig: true,
    });
  });

  it('falls back to serverMessage for a NON-duplicate failure', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      await onError(new Error('rate limited'), 'server error message');
    });

    expect(mockShowMessage).toHaveBeenCalledWith('server error message', 'error');
    expect(screen.queryByText(/Home Wall/)).toBeNull();
  });

  it('falls back to the i18n error key when there is no serverMessage', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      await onError(new Error('error'), null);
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Failed to create board. It may already exist for this configuration.',
      'error',
    );
  });

  it('does not treat an unrelated error as a duplicate', async () => {
    // The old behaviour: any error plus an owned board of this config read as a
    // duplicate. Only the server's code decides now.
    const onError = renderAndGetOnError();

    await act(async () => {
      await onError({ response: { errors: [{ extensions: { code: 'RATE_LIMITED' } }] } }, 'slow down');
    });

    expect(mockShowMessage).toHaveBeenCalledWith('slow down', 'error');
    expect(screen.queryByText('Add it anyway')).toBeNull();
  });

  it('names the account cap instead of echoing the server message', async () => {
    // 'board_limit' has to stay out of the 'exception' bucket: no retry clears
    // it, and the way out (delete a board) belongs in our own copy.
    const onError = renderAndGetOnError();

    await act(async () => {
      await onError(
        {
          response: {
            errors: [
              {
                message: 'You have reached the maximum of 50 boards for one account',
                extensions: { code: 'BOARD_LIMIT_REACHED', maxBoards: 50 },
              },
            ],
          },
        },
        'You have reached the maximum of 50 boards for one account',
      );
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      "You've reached the maximum number of boards for one account. Delete a board you no longer use to add another.",
      'error',
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'Board Create Failed',
      expect.objectContaining({ error_reason: 'board_limit' }),
    );
  });

  it('ignores a malformed duplicate payload with no board uuid', async () => {
    const onError = renderAndGetOnError();

    await act(async () => {
      await onError(duplicateError({ existingBoardUuid: undefined }), 'server error message');
    });

    expect(mockShowMessage).toHaveBeenCalledWith('server error message', 'error');
  });
});
