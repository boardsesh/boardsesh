import { describe, expect, it } from 'vitest';
import { readUnknownBoardConfigError } from '../errors';

const clientError = (extensions: Record<string, unknown>) => ({ response: { errors: [{ message: 'x', extensions }] } });
const rethrown = (extensions: Record<string, unknown>) => ({ graphqlErrors: [{ message: 'x', extensions }] });

describe('readUnknownBoardConfigError', () => {
  it('reads the refused field and set ids from either error shape', () => {
    const extensions = { code: 'UNKNOWN_BOARD_CONFIG', field: 'setIds', invalidSetIds: [20, 21] };
    const expected = { field: 'setIds', invalidSetIds: [20, 21] };
    expect(readUnknownBoardConfigError(clientError(extensions))).toEqual(expected);
    expect(readUnknownBoardConfigError(rethrown(extensions))).toEqual(expected);
  });

  it('reads an older server that sends the code alone as no field', () => {
    expect(readUnknownBoardConfigError(clientError({ code: 'UNKNOWN_BOARD_CONFIG' }))).toEqual({
      field: null,
      invalidSetIds: [],
    });
  });

  it('drops a field it does not know and set ids that are not integers', () => {
    expect(
      readUnknownBoardConfigError(
        clientError({ code: 'UNKNOWN_BOARD_CONFIG', field: 'colour', invalidSetIds: [3, '4', 1.5, null] }),
      ),
    ).toEqual({ field: null, invalidSetIds: [3] });
  });

  it('is null for any other error', () => {
    expect(readUnknownBoardConfigError(clientError({ code: 'BOARD_EXISTING_WALLS' }))).toBeNull();
    expect(readUnknownBoardConfigError(new Error('offline'))).toBeNull();
  });
});
