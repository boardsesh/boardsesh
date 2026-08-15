import { describe, it, expect } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { selectForeignSerialBoards, extractSerialExistsError, serialReuseDisclosure } from '../serial-reuse';

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'b-default',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 2,
    setIds: '3,4',
    name: 'Board',
    canEdit: false,
    ...overrides,
  } as unknown as UserBoard;
}

describe('selectForeignSerialBoards', () => {
  it('excludes boards the user can edit', () => {
    const mine = board({ uuid: 'mine', canEdit: true });
    const theirs = board({ uuid: 'theirs', canEdit: false });
    const result = selectForeignSerialBoards([mine, theirs], null);
    expect(result.map((entry) => entry.uuid)).toEqual(['theirs']);
  });

  it('excludes the board currently being edited', () => {
    const current = board({ uuid: 'current', canEdit: false });
    const other = board({ uuid: 'other', canEdit: false });
    const result = selectForeignSerialBoards([current, other], null, 'current');
    expect(result.map((entry) => entry.uuid)).toEqual(['other']);
  });

  it('orders the same-config match first', () => {
    const differentConfig = board({ uuid: 'diff', layoutId: 99 });
    const sameConfig = board({ uuid: 'same', layoutId: 1, sizeId: 2, setIds: '4,3' });
    const result = selectForeignSerialBoards([differentConfig, sameConfig], {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 2,
      // Set-id order differs from the stored board — normalised match still wins.
      setIds: '3,4',
    });
    expect(result.map((entry) => entry.uuid)).toEqual(['same', 'diff']);
  });

  it('returns empty when every match is editable', () => {
    expect(selectForeignSerialBoards([board({ canEdit: true })], null)).toEqual([]);
  });
});

describe('extractSerialExistsError', () => {
  it('reads the BOARD_SERIAL_EXISTS extension from a ClientError-shaped error', () => {
    const error = {
      response: {
        errors: [
          {
            message: 'Serial already registered',
            extensions: { code: 'BOARD_SERIAL_EXISTS', boardUuid: 'canonical-1', slug: 'the-wall', name: 'The Wall' },
          },
        ],
      },
    };
    expect(extractSerialExistsError(error)).toEqual({
      kind: 'board',
      boardUuid: 'canonical-1',
      slug: 'the-wall',
      name: 'The Wall',
    });
  });

  it('tolerates missing slug/name', () => {
    const error = { response: { errors: [{ extensions: { code: 'BOARD_SERIAL_EXISTS', boardUuid: 'c-2' } }] } };
    expect(extractSerialExistsError(error)).toEqual({ kind: 'board', boardUuid: 'c-2', slug: null, name: null });
  });

  it('returns null for other errors', () => {
    expect(extractSerialExistsError({ response: { errors: [{ extensions: { code: 'RATE_LIMITED' } }] } })).toBeNull();
    expect(extractSerialExistsError(new Error('boom'))).toBeNull();
    expect(extractSerialExistsError(null)).toBeNull();
  });

  it('reports a private conflict when the code matches but the payload is masked', () => {
    // The backend omits boardUuid/slug/name when the existing board is private
    // (serial-enumeration guard) — the create is still blocked, so the caller
    // must be told to offer "create anyway" without a board to jump to.
    const error = { response: { errors: [{ extensions: { code: 'BOARD_SERIAL_EXISTS' } }] } };
    expect(extractSerialExistsError(error)).toEqual({ kind: 'private' });
  });
});

describe('serialReuseDisclosure', () => {
  it('carries the board entity only for public matches', () => {
    const publicBoard = board({ isPublic: true, name: 'Public wall' });
    expect(serialReuseDisclosure(publicBoard)).toEqual({ kind: 'public', board: publicBoard });
  });

  it('reduces a private match to an identity-free marker', () => {
    const privateBoard = board({
      isPublic: false,
      name: 'Secret wall',
      locationName: 'Private address',
      ownerId: 'private-owner',
    });
    expect(serialReuseDisclosure(privateBoard)).toEqual({ kind: 'private' });
  });
});
