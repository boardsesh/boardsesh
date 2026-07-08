import { describe, it, expect } from 'vitest';
import { boardDownloadState, boardIsBootstrapping } from '../board-offline-state';

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

  it('is downloading while the snapshot-bootstrap phase is warming this exact scope', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'kilter:1:5', phase: 'bootstrap' })).toBe(
      'downloading',
    );
  });

  it('does not cross-trigger bootstrap on a sibling scope with a shared prefix', () => {
    expect(
      boardDownloadState({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isSyncing: true,
        downloaded: false,
        currentTable: 'kilter:1:5',
        phase: 'bootstrap',
      }),
    ).toBe('pending');
  });

  it('does not read as downloading when currentTable matches but the phase is not bootstrap', () => {
    // A bare scope key matching currentTable only means "bootstrapping" when
    // phase is actually 'bootstrap' — this guards against a stale/undefined
    // phase accidentally matching.
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'kilter:1:5', phase: null })).toBe('pending');
  });
});

describe('boardIsBootstrapping', () => {
  it('is true only during the bootstrap phase for this exact scope while syncing', () => {
    expect(boardIsBootstrapping({ ...base, isSyncing: true, currentTable: 'kilter:1:5', phase: 'bootstrap' })).toBe(
      true,
    );
  });

  it('is false during the paged board_data phase, even for this scope', () => {
    expect(
      boardIsBootstrapping({
        ...base,
        isSyncing: true,
        currentTable: 'board_climbs:kilter:1:5',
        phase: 'board_data',
      }),
    ).toBe(false);
  });

  it('is false when not syncing at all', () => {
    expect(boardIsBootstrapping({ ...base, isSyncing: false, currentTable: 'kilter:1:5', phase: 'bootstrap' })).toBe(
      false,
    );
  });

  it('is false for a sibling scope sharing the bootstrap phase', () => {
    expect(
      boardIsBootstrapping({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isSyncing: true,
        downloaded: false,
        currentTable: 'kilter:1:5',
        phase: 'bootstrap',
      }),
    ).toBe(false);
  });
});
