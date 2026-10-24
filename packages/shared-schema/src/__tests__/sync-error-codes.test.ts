import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
  DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
  FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
  FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR,
  boardAccountSyncErrorCode,
  boardAccountSyncWarningKind,
  circuitPlaylistConflictSyncError,
  circuitPlaylistSyncWarningKind,
  circuitPlaylistSyncWireFields,
} from '../sync-error-codes';

describe('circuit playlist sync error codes', () => {
  it('encodes each persistent ownership state', () => {
    expect(circuitPlaylistConflictSyncError('none')).toBeNull();
    expect(circuitPlaylistConflictSyncError('foreign')).toBe(FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
    expect(circuitPlaylistConflictSyncError('ambiguous')).toBe(AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
  });

  it('decodes current and legacy warning codes without swallowing unknown errors', () => {
    expect(circuitPlaylistSyncWarningKind(FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBe('foreign');
    expect(circuitPlaylistSyncWarningKind(AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBe('ambiguous');
    expect(circuitPlaylistSyncWarningKind(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBe('legacy');
    expect(circuitPlaylistSyncWarningKind('Refresh token rejected')).toBeNull();
    expect(circuitPlaylistSyncWarningKind(null)).toBeNull();
  });

  it('keeps the legacy code on the wire while preserving a precise reason for current clients', () => {
    expect(circuitPlaylistSyncWireFields(FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toEqual({
      syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
      syncErrorReason: 'foreign',
    });
    expect(circuitPlaylistSyncWireFields(AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toEqual({
      syncError: DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
      syncErrorReason: 'ambiguous',
    });
    expect(circuitPlaylistSyncWireFields('Refresh token rejected')).toEqual({
      syncError: 'Refresh token rejected',
    });
    expect(circuitPlaylistSyncWarningKind(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR, 'foreign')).toBe('foreign');
    expect(circuitPlaylistSyncWarningKind(FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR, 'ambiguous')).toBe('foreign');
    expect(circuitPlaylistSyncWarningKind('Refresh token rejected', 'foreign')).toBeNull();
    expect(circuitPlaylistSyncWarningKind(null, 'ambiguous')).toBeNull();
  });

  describe('logbook owned by another account (#6687)', () => {
    it('decodes the logbook code and still delegates every circuits code', () => {
      expect(boardAccountSyncWarningKind(FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR)).toBe('logbook');
      expect(boardAccountSyncWarningKind(FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBe('foreign');
      expect(boardAccountSyncWarningKind(AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBe('ambiguous');
      expect(boardAccountSyncWarningKind(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)).toBe('legacy');
      expect(boardAccountSyncWarningKind(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR, 'foreign')).toBe('foreign');
      expect(boardAccountSyncWarningKind('Refresh token rejected')).toBeNull();
      expect(boardAccountSyncWarningKind(null)).toBeNull();
    });

    it('sends the logbook code over REST unchanged, never as the legacy circuits code', () => {
      // An app that predates the code shows its generic error line for it. The
      // legacy circuits copy it would get instead told the climber their sends
      // were still arriving, which is the exact false promise #6687 removes.
      expect(circuitPlaylistSyncWireFields(FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR)).toEqual({
        syncError: FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR,
      });
    });

    it('stores the logbook code over any circuits code, and the circuits code otherwise', () => {
      expect(
        boardAccountSyncErrorCode({
          logbookOwnedElsewhere: true,
          circuitsSyncError: FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
        }),
      ).toBe(FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR);
      expect(boardAccountSyncErrorCode({ logbookOwnedElsewhere: true, circuitsSyncError: null })).toBe(
        FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR,
      );
      expect(
        boardAccountSyncErrorCode({
          logbookOwnedElsewhere: false,
          circuitsSyncError: AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
        }),
      ).toBe(AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
      expect(boardAccountSyncErrorCode({ logbookOwnedElsewhere: false, circuitsSyncError: null })).toBeNull();
    });
  });
});
