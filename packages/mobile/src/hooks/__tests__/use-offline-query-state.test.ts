import { describe, expect, it } from 'vitest';
import {
  deriveOfflineQueryState,
  type OfflineQueryConnectivity,
  type OfflineQueryInput,
} from '../use-offline-query-state';
import { createGraphqlTimeoutError } from '../../lib/graphql/request-timeout';
import { BackendUnavailableError } from '../../lib/connectivity/backend-unavailable-error';

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

  it('blames our server for a timeout the connectivity store has not caught up with yet', () => {
    // Issue #6937: a slow backend timed the request out, but the store needs a
    // failed health probe before it declares an outage, so it still reads reachable.
    const timedOut: OfflineQueryInput = { ...idleError, error: createGraphqlTimeoutError(20_000) };
    expect(deriveOfflineQueryState([timedOut], reachable)).toEqual({
      isOffline: false,
      isBlocked: true,
      reason: 'backend_unreachable',
    });
  });

  it('blames our server for a 5xx, a dropped connection and a masked server error', () => {
    const serverErrors: unknown[] = [
      { response: { status: 503 } },
      { response: { status: 500 } },
      { response: { status: 504 } },
      // An edge that failed to route: a GraphQL server never answers 404 itself.
      { response: { status: 404 } },
      new TypeError('Network request failed'),
      { response: { status: 200, errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } },
    ];
    for (const error of serverErrors) {
      expect(deriveOfflineQueryState([{ ...idleError, error }], reachable).reason).toBe('backend_unreachable');
    }
  });

  it('keeps the generic error for a request the server answered and refused', () => {
    const refused: OfflineQueryInput = {
      ...idleError,
      error: { response: { status: 200, errors: [{ message: 'nope', extensions: { code: 'FORBIDDEN' } }] } },
    };
    expect(deriveOfflineQueryState([refused], reachable).reason).toBe('error');
    for (const status of [400, 401, 429]) {
      expect(deriveOfflineQueryState([{ ...idleError, error: { response: { status } } }], reachable).reason).toBe(
        'error',
      );
    }
    // English transport prose on a request that still got a status is the server answering.
    const answeredWithTimeoutProse = Object.assign(new Error('The request timed out.'), { response: { status: 400 } });
    expect(deriveOfflineQueryState([{ ...idleError, error: answeredWithTimeoutProse }], reachable).reason).toBe(
      'error',
    );
  });

  it('reads the error only off queries that are in the error state', () => {
    // Defensive: an error left on a query that is not failing must not colour
    // another query's failure.
    const notFailingWithStaleError: OfflineQueryInput = {
      status: 'pending',
      fetchStatus: 'fetching',
      error: createGraphqlTimeoutError(20_000),
    };
    expect(deriveOfflineQueryState([notFailingWithStaleError, idleError], reachable).reason).toBe('error');
  });

  it('blames our server only for a short-circuited request whose reason was our server', () => {
    const blockedBy = (reason: 'backend_unreachable' | 'offline_mode' | 'device_offline') =>
      deriveOfflineQueryState([{ ...idleError, error: new BackendUnavailableError(reason) }], reachable).reason;
    expect(blockedBy('backend_unreachable')).toBe('backend_unreachable');
    expect(blockedBy('offline_mode')).toBe('error');
    expect(blockedBy('device_offline')).toBe('error');
  });

  it('does not blame our server for a request that was cancelled', () => {
    const cancelled = new Error('Aborted');
    cancelled.name = 'AbortError';
    expect(deriveOfflineQueryState([{ ...idleError, error: cancelled }], reachable).reason).toBe('error');
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
