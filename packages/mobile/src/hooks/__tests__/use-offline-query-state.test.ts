import { describe, expect, it } from 'vitest';
import { deriveOfflineQueryState, type OfflineQueryInput } from '../use-offline-query-state';

const pausedPending: OfflineQueryInput = { status: 'pending', fetchStatus: 'paused' };
const fetchingPending: OfflineQueryInput = { status: 'pending', fetchStatus: 'fetching' };
const idleError: OfflineQueryInput = { status: 'error', fetchStatus: 'idle' };
const loadedEmptyList: OfflineQueryInput = { status: 'success', fetchStatus: 'idle', data: [] };
const loadedRows: OfflineQueryInput = { status: 'success', fetchStatus: 'idle', data: [{ id: 'a' }] };

describe('deriveOfflineQueryState', () => {
  it('reports a paused query as blocked-offline — the permanent-spinner case', () => {
    // networkMode: 'offlineFirst' leaves status 'pending' forever, which every
    // screen reads as "still loading". fetchStatus is the honest signal.
    expect(deriveOfflineQueryState([pausedPending], true)).toEqual({
      isOffline: true,
      isBlocked: true,
      reason: 'offline',
    });
  });

  it('trusts a paused query over a stale onlineManager read', () => {
    expect(deriveOfflineQueryState([pausedPending], false).reason).toBe('offline');
  });

  it('does not claim "no signal" for a query that failed while online', () => {
    expect(deriveOfflineQueryState([idleError], false)).toEqual({
      isOffline: false,
      isBlocked: true,
      reason: 'error',
    });
  });

  it('treats an error while offline as offline, not as a server failure', () => {
    expect(deriveOfflineQueryState([idleError], true).reason).toBe('offline');
  });

  it('is not blocked while a fetch is genuinely in flight', () => {
    expect(deriveOfflineQueryState([fetchingPending], false)).toEqual({
      isOffline: false,
      isBlocked: false,
      reason: null,
    });
  });

  it('is not blocked once a query has resolved, even to an empty list', () => {
    // An honestly-empty answer is the screen's own empty state, not ours.
    expect(deriveOfflineQueryState([loadedEmptyList], true).isBlocked).toBe(false);
  });

  it('renders the data it has rather than a placard when one of several queries succeeded', () => {
    expect(deriveOfflineQueryState([pausedPending, loadedRows], true).isBlocked).toBe(false);
  });

  it('blocks when every query in the set is stalled', () => {
    expect(deriveOfflineQueryState([pausedPending, idleError], true).isBlocked).toBe(true);
  });

  it('is not blocked with no queries at all', () => {
    expect(deriveOfflineQueryState([], true)).toEqual({ isOffline: true, isBlocked: false, reason: null });
  });

  it('carries isOffline through even when nothing is blocked', () => {
    expect(deriveOfflineQueryState([loadedRows], true).isOffline).toBe(true);
  });
});
