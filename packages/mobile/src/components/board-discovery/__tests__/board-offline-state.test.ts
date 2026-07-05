import { describe, it, expect } from 'vitest';
import { boardDownloadState } from '../board-offline-state';

const base = {
  scopeKey: 'kilter:1:5',
  enabled: true,
  isSyncing: false,
  lastSyncedAt: null as number | null,
  currentTable: null as string | null,
};

describe('boardDownloadState', () => {
  it('is off when the board is not enabled', () => {
    expect(boardDownloadState({ ...base, enabled: false })).toBe('off');
  });

  it('is pending when enabled but never synced', () => {
    expect(boardDownloadState({ ...base, enabled: true, lastSyncedAt: null })).toBe('pending');
  });

  it('is downloaded after a cycle has completed', () => {
    expect(boardDownloadState({ ...base, lastSyncedAt: 1_700_000_000_000 })).toBe('downloaded');
  });

  it('is downloading while its own board_climbs table is being pulled', () => {
    expect(
      boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climbs:kilter:1:5' }),
    ).toBe('downloading');
  });

  it('is downloading while its own board_climb_stats table is being pulled', () => {
    expect(
      boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climb_stats:kilter:1:5' }),
    ).toBe('downloading');
  });

  it('does not cross-trigger on a sibling scope with a shared prefix', () => {
    // kilter:1:50 must not read as downloading when kilter:1:5 is the one syncing.
    expect(
      boardDownloadState({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isSyncing: true,
        lastSyncedAt: null,
        currentTable: 'board_climbs:kilter:1:5',
      }),
    ).toBe('pending');
  });

  it('stays downloaded when a later cycle is syncing a different board', () => {
    expect(
      boardDownloadState({
        ...base,
        isSyncing: true,
        lastSyncedAt: 1_700_000_000_000,
        currentTable: 'board_climbs:tension:8:10',
      }),
    ).toBe('downloaded');
  });
});
