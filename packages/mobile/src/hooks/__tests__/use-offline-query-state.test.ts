import { describe, expect, it } from 'vitest';
import {
  deriveOfflineQueryState,
  type OfflineQueryConnectivity,
  type OfflineQueryInput,
} from '../use-offline-query-state';

const pausedPending: OfflineQueryInput = { status: 'pending', fetchStatus: 'paused' };
const fetchingPending: OfflineQueryInput = { status: 'pending', fetchStatus: 'fetching' };
const idleError: OfflineQueryInput = { status: 'error', fetchStatus: 'idle' };
const loadedEmptyList: OfflineQueryInput = { status: 'success', fetchStatus: 'idle', data: [] };
const loadedRows: OfflineQueryInput = { status: 'success', fetchStatus: 'idle', data: [{ id: 'a' }] };

const reachable: OfflineQueryConnectivity = { effectiveOffline: false, reason: null };
const noSignal: OfflineQueryConnectivity = { effectiveOffline: true, reason: 'device_offline' };
const offlineMode: OfflineQueryConnectivity = { effectiveOffline: true, reason: 'offline_mode' };
const backendDown: OfflineQueryConnectivity = { effectiveOffline: true, reason: 'backend_unreachable' };

describe('deriveOfflineQueryState', () => {
  it('reports a paused query as blocked-offline — the permanent-spinner case', () => {
    // networkMode: 'offlineFirst' leaves status 'pending' forever, which every
    // screen reads as "still loading". fetchStatus is the honest signal.
    expect(deriveOfflineQueryState([pausedPending], noSignal)).toEqual({
      isOffline: true,
      isBlocked: true,
      reason: 'offline',
    });
  });

  it('trusts a paused query over a stale store read', () => {
    expect(deriveOfflineQueryState([pausedPending], reachable).reason).toBe('offline');
  });

  it('blames our server, not the phone, when the backend is the thing that is down', () => {
    // The whole point of #4862: a paused query only says "the network layer said
    // no", and only the connectivity store knows which side is at fault.
    expect(deriveOfflineQueryState([pausedPending], backendDown)).toEqual({
      isOffline: true,
      isBlocked: true,
      reason: 'backend_unreachable',
    });
  });

  it('names Offline mode when the climber turned it on themselves', () => {
    expect(deriveOfflineQueryState([pausedPending], offlineMode).reason).toBe('offline_mode');
  });

  it('does not claim "no signal" for a query that failed while everything was reachable', () => {
    expect(deriveOfflineQueryState([idleError], reachable)).toEqual({
      isOffline: false,
      isBlocked: true,
      reason: 'error',
    });
  });

  it('treats an error while offline as offline, not as a server failure', () => {
    expect(deriveOfflineQueryState([idleError], noSignal).reason).toBe('offline');
  });

  it('treats an error against an unreachable backend as our outage', () => {
    // The request that raced a connectivity change: it errored rather than
    // pausing, but the reason it could not land is still us being down.
    expect(deriveOfflineQueryState([idleError], backendDown).reason).toBe('backend_unreachable');
  });

  it('is not blocked while a fetch is genuinely in flight', () => {
    expect(deriveOfflineQueryState([fetchingPending], reachable)).toEqual({
      isOffline: false,
      isBlocked: false,
      reason: null,
    });
  });

  it('is not blocked once a query has resolved, even to an empty list', () => {
    // An honestly-empty answer is the screen's own empty state, not ours.
    expect(deriveOfflineQueryState([loadedEmptyList], noSignal).isBlocked).toBe(false);
  });

  it('renders the data it has rather than a placard when one of several queries succeeded', () => {
    expect(deriveOfflineQueryState([pausedPending, loadedRows], noSignal).isBlocked).toBe(false);
  });

  it('lets data win over an unreachable backend too', () => {
    // Stale rows beat every placard, the server-trouble one included.
    expect(deriveOfflineQueryState([pausedPending, loadedRows], backendDown)).toEqual({
      isOffline: true,
      isBlocked: false,
      reason: null,
    });
  });

  it('blocks when every query in the set is stalled', () => {
    expect(deriveOfflineQueryState([pausedPending, idleError], noSignal).isBlocked).toBe(true);
  });

  it('is not blocked with no queries at all', () => {
    expect(deriveOfflineQueryState([], noSignal)).toEqual({ isOffline: true, isBlocked: false, reason: null });
  });

  it('carries isOffline through even when nothing is blocked', () => {
    expect(deriveOfflineQueryState([loadedRows], noSignal).isOffline).toBe(true);
  });
});
