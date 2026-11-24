import { describe, expect, it } from 'vitest';
import { isBoardSetupAlreadyUndoneError, isBoardSetupChangedSinceError, isBoardSetupUnchangedError } from '../errors';

/** graphql-request's ClientError shape, and the re-thrown `graphqlErrors` shape. */
const clientError = (extensions: Record<string, unknown>) => ({ response: { errors: [{ message: 'x', extensions }] } });
const rethrown = (extensions: Record<string, unknown>) => ({ graphqlErrors: [{ message: 'x', extensions }] });

describe('suggested setup error readers', () => {
  it('tells "the board already has this setup" from any other bad input', () => {
    expect(isBoardSetupUnchangedError(clientError({ code: 'BAD_USER_INPUT', reason: 'SETUP_UNCHANGED' }))).toBe(true);
    expect(isBoardSetupUnchangedError(rethrown({ code: 'BAD_USER_INPUT', reason: 'SETUP_UNCHANGED' }))).toBe(true);
    expect(isBoardSetupUnchangedError(clientError({ code: 'BAD_USER_INPUT' }))).toBe(false);
    expect(isBoardSetupUnchangedError(clientError({ code: 'FORBIDDEN', reason: 'SETUP_UNCHANGED' }))).toBe(false);
  });

  it('tells an undo someone made first from a board that changed since', () => {
    const undone = clientError({ code: 'BOARD_SETUP_ALREADY_UNDONE' });
    const changed = clientError({ code: 'BOARD_SETUP_CHANGED_SINCE' });
    expect(isBoardSetupAlreadyUndoneError(undone)).toBe(true);
    expect(isBoardSetupChangedSinceError(undone)).toBe(false);
    expect(isBoardSetupChangedSinceError(changed)).toBe(true);
    expect(isBoardSetupAlreadyUndoneError(changed)).toBe(false);
  });

  it('reads nothing from something that is not a GraphQL error', () => {
    for (const notAnError of [null, undefined, 'BOARD_SETUP_ALREADY_UNDONE', new Error('SETUP_UNCHANGED')]) {
      expect(isBoardSetupAlreadyUndoneError(notAnError)).toBe(false);
      expect(isBoardSetupUnchangedError(notAnError)).toBe(false);
    }
  });
});
