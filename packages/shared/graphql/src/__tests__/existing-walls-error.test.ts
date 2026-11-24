import { describe, expect, it } from 'vitest';
import { readExistingWallsError } from '../errors';

const clientError = (extensions: Record<string, unknown>) => ({ response: { errors: [{ message: 'x', extensions }] } });
const rethrown = (extensions: Record<string, unknown>) => ({ graphqlErrors: [{ message: 'x', extensions }] });

describe('readExistingWallsError', () => {
  it('reads the named walls from either error shape', () => {
    const extensions = {
      code: 'BOARD_EXISTING_WALLS',
      candidates: [
        { boardUuid: 'wall-1', matchKind: 'EXACT' },
        { boardUuid: 'wall-2', matchKind: 'SETS_DIFFER' },
      ],
    };
    const expected = [
      { boardUuid: 'wall-1', matchKind: 'EXACT' },
      { boardUuid: 'wall-2', matchKind: 'SETS_DIFFER' },
    ];
    expect(readExistingWallsError(clientError(extensions))).toEqual(expected);
    expect(readExistingWallsError(rethrown(extensions))).toEqual(expected);
  });

  it('drops malformed entries and an unknown match kind, but still reports the refusal', () => {
    expect(
      readExistingWallsError(
        clientError({
          code: 'BOARD_EXISTING_WALLS',
          candidates: [null, { matchKind: 'EXACT' }, { boardUuid: 'wall-3', matchKind: 'SOMETHING_NEW' }],
        }),
      ),
    ).toEqual([{ boardUuid: 'wall-3', matchKind: null }]);
    expect(readExistingWallsError(clientError({ code: 'BOARD_EXISTING_WALLS' }))).toEqual([]);
  });

  it('is null for any other error', () => {
    expect(readExistingWallsError(clientError({ code: 'BOARD_DUPLICATE_CONFIG' }))).toBeNull();
    expect(readExistingWallsError(new Error('BOARD_EXISTING_WALLS'))).toBeNull();
    expect(readExistingWallsError(null)).toBeNull();
  });
});
