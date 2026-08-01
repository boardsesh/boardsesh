import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
  DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
  FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
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
});
