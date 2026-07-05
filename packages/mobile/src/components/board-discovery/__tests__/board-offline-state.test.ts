import { describe, it, expect } from 'vitest';
import { boardDownloadState } from '../board-offline-state';

const base = {
  scopeKey: 'kilter:1:5',
  enabled: true,
  isSyncing: false,
  downloaded: false,
  currentTable: null as string | null,
};

describe('boardDownloadState', () => {
  it('is off when the board is not enabled', () => {
    expect(boardDownloadState({ ...base, enabled: false })).toBe('off');
  });

  it('is pending when enabled but its own data has not landed', () => {
    expect(boardDownloadState({ ...base, enabled: true, downloaded: false })).toBe('pending');
  });

  it('is downloaded once its own checkpoint exists', () => {
    expect(boardDownloadState({ ...base, downloaded: true })).toBe('downloaded');
  });

  it('is downloading while its own board_climbs table is being pulled', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climbs:kilter:1:5' })).toBe(
      'downloading',
    );
  });

  it('is downloading while its own board_climb_stats table is being pulled', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climb_stats:kilter:1:5' })).toBe(
      'downloading',
    );
  });

  it('does not cross-trigger on a sibling scope with a shared prefix', () => {
    // kilter:1:50 must not read as downloading when kilter:1:5 is the one syncing.
    expect(
      boardDownloadState({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isSyncing: true,
        downloaded: false,
        currentTable: 'board_climbs:kilter:1:5',
      }),
    ).toBe('pending');
  });

  it('a freshly-enabled board stays pending while another board is mid-cycle', () => {
    // Its own data hasn't landed yet even though a cycle is running for a sibling.
    expect(
      boardDownloadState({
        ...base,
        isSyncing: true,
        downloaded: false,
        currentTable: 'board_climbs:tension:8:10',
      }),
    ).toBe('pending');
  });

  it('stays downloaded when a later cycle is syncing a different board', () => {
    expect(
      boardDownloadState({
        ...base,
        isSyncing: true,
        downloaded: true,
        currentTable: 'board_climbs:tension:8:10',
      }),
    ).toBe('downloaded');
  });
});
