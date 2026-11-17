import { garminFunction } from './garmin-source';
import type { GarminRecording } from './recordings';

type Scope = Record<string, unknown>;
type Replayed = (...arguments_: unknown[]) => unknown;
export interface WatchReply {
  readonly status: number;
  readonly body: unknown;
}
/** Sends one watch request to the mounted backend; the watch library owns no I/O here. */
export type WatchPost = (path: string, body: unknown) => Promise<WatchReply>;

/**
 * `instanceof Lang.Number` is the one type predicate garminFunction does not
 * respell; this keeps it a predicate over the value instead of a VM global.
 */
const Lang = {
  Number: { [Symbol.hasInstance]: (candidate: unknown) => Number.isInteger(candidate) },
};

function replayAll(recording: GarminRecording, path: string, names: readonly string[], scope: Scope) {
  for (const name of names) scope[name] = garminFunction(recording, path, name, scope);
}

function endpoints(recording: GarminRecording) {
  const scope: Scope = {};
  replayAll(recording, 'net/BsEndpoints.mc', ['pairUrl', 'pairBody', 'refreshUrl', 'refreshBody'], scope);
  return {
    pairPath: new URL(String((scope.pairUrl as Replayed)('http://watch.invalid'))).pathname,
    refreshPath: new URL(String((scope.refreshUrl as Replayed)('http://watch.invalid'))).pathname,
    pairBody: scope.pairBody as Replayed,
    refreshBody: scope.refreshBody as Replayed,
  };
}

/**
 * The reviewed G2 checkpoint's own auth state machine, token store, pairing
 * consumer, refresh completion, refresh flight and queued-request retry,
 * replayed from the recorded Monkey C over one in-memory storage value.
 * Storage, routing, recording and the network are adapters. The queued request
 * stands for an offline tick upload waiting behind the refresh.
 */
export function createG2Watch(recording: GarminRecording) {
  if (recording.name !== 'g2-reviewed') throw new Error('G2 watch replay needs the reviewed G2 recording');
  const stored = new Map<string, unknown>();
  const effects: string[] = [];
  const authState: Scope = { VERSION: 2, MAX_COUNTER: 2147483646, Lang };
  authState.AuthState = authState;
  replayAll(
    recording,
    'auth/AuthState.mc',
    [
      'nonempty',
      'counter',
      'statusIs',
      'sameOwner',
      'valid',
      'empty',
      'bootstrap',
      'sameScope',
      'sameRevision',
      'clear',
      'beginRotation',
      'resumeUnconsumed',
      'canUseAccess',
      'responseValid',
      'accept',
    ],
    authState,
  );
  const tokenStore: Scope = {
    KEY: 'bs.auth.v2',
    KEY_JWT: 'bs.jwt',
    KEY_REFRESH: 'bs.refresh',
    KEY_EXP: 'bs.exp',
    _blocked: false,
    AuthState: authState,
    WatchStore: {
      read: (key: string) => stored.get(key) ?? null,
      write: (key: string, value: unknown) => stored.set(key, value),
    },
  };
  replayAll(
    recording,
    'auth/TokenStore.mc',
    [
      'snapshot',
      'current',
      'currentRevision',
      'replace',
      'clear',
      'beginPairing',
      'acceptPair',
      'beginRotation',
      'acceptRotation',
      'jwt',
    ],
    tokenStore,
  );
  const responses = { STALE: -32001 };
  const policyScope: Scope = { Communications: { BLE_CONNECTION_UNAVAILABLE: -101, BLE_QUEUE_FULL: -102 }, Lang };
  replayAll(recording, 'net/BsClient.mc', ['provenUnconsumed'], policyScope);
  const clientScope: Scope = {
    TokenStore: tokenStore,
    AuthState: authState,
    BsResponse: responses,
    BsRefreshPolicy: { provenUnconsumed: policyScope.provenUnconsumed },
    _flight: null,
    _authLost() {
      effects.push('auth-lost');
    },
  };
  replayAll(recording, 'net/BsClient.mc', ['refreshFinished'], clientScope);
  const routes = endpoints(recording);
  const call = (scope: Scope, name: string, ...arguments_: unknown[]) => (scope[name] as Replayed)(...arguments_);

  /** One queued authed request: its recorded retryWith decides whether it re-fires. */
  function queuedRequest(label: string) {
    const scope: Scope = {
      _captured: call(tokenStore, 'snapshot'),
      _retried: false,
      TokenStore: tokenStore,
      AuthState: authState,
      BsResponse: responses,
      fire() {
        effects.push(`${label}:resent`);
      },
      fail(code: number) {
        effects.push(`${label}:failed:${code}`);
      },
    };
    replayAll(recording, 'net/BsClient.mc', ['retryWith'], scope);
    return { retryWith: scope.retryWith, fail: scope.fail };
  }

  return {
    effects,
    paths: { pair: routes.pairPath, refresh: routes.refreshPath },
    state: () => call(tokenStore, 'snapshot') as Scope | null,
    accessJwt: () => call(tokenStore, 'jwt') as string | null,
    /** PairingView._submit's storage step, the watch request, then onPairResult. */
    async pair(code: string, post: WatchPost) {
      const attempt = call(tokenStore, 'beginPairing');
      if (!attempt) throw new Error('G2 watch storage refused a pairing attempt');
      const view: Scope = {
        _submitting: true,
        _attempt: attempt,
        _error: false,
        _entered: code,
        _index: 0,
        BsResponse: responses,
        AuthState: authState,
        TokenStore: tokenStore,
        Router: {
          toLoading() {
            effects.push('paired');
          },
        },
        WatchUi: { requestUpdate() {} },
      };
      replayAll(recording, 'views/PairingView.mc', ['onPairResult'], view);
      const reply = await post(routes.pairPath, routes.pairBody(code));
      call(view, 'onPairResult', reply.status, reply.body, attempt);
      return { ...reply, refused: view._error === true };
    },
    /**
     * A refresh with `queued` requests waiting in its flight. The flight and
     * its finish are the recorded BsRefreshFlight; each waiting request is the
     * recorded BsRequest.retryWith over the snapshot it captured before.
     */
    async refresh(post: WatchPost, queued = 1) {
      const waiting = Array.from({ length: queued }, (_unused, index) => queuedRequest(`tick-${index}`));
      const captured = call(tokenStore, 'snapshot');
      const pending = call(tokenStore, 'beginRotation', captured) as Scope | null;
      if (!pending) throw new Error('G2 watch refused to begin a rotation');
      const flightScope: Scope = { _settled: false, _queue: waiting };
      replayAll(recording, 'net/BsClient.mc', ['finish'], flightScope);
      const flight = { finish: flightScope.finish };
      clientScope._flight = flight;
      const reply = await post(routes.refreshPath, routes.refreshBody(pending.refresh));
      call(clientScope, 'refreshFinished', flight, pending, reply.status, reply.body);
      return reply;
    },
  };
}

/**
 * The pre-G2 checkpoint (`main-before-g2`): three plain storage keys, the
 * PairingView consumer and the refresh completion with its definitive-failure
 * and transient branches, replayed from the recorded source. Its TickQueue is
 * an adapter that records a clear; the queued request records resend/failure.
 */
export function createPreG2Watch(recording: GarminRecording) {
  if (recording.name !== 'main-before-g2') throw new Error('Pre-G2 watch replay needs the main-before-g2 recording');
  const stored = new Map<string, unknown>();
  const effects: string[] = [];
  const tokenStore: Scope = {
    KEY_JWT: 'bs.jwt',
    KEY_REFRESH: 'bs.refresh',
    KEY_EXP: 'bs.exp',
    Application: {
      Storage: {
        getValue: (key: string) => stored.get(key) ?? null,
        setValue: (key: string, value: unknown) => stored.set(key, value),
        deleteValue: (key: string) => stored.delete(key),
      },
    },
  };
  replayAll(recording, 'auth/TokenStore.mc', ['jwt', 'refreshToken', 'store', 'clear'], tokenStore);
  const tickQueue = {
    clear() {
      effects.push('tick-queue-cleared');
    },
  };
  const routes = endpoints(recording);
  const call = (scope: Scope, name: string, ...arguments_: unknown[]) => (scope[name] as Replayed)(...arguments_);
  return {
    effects,
    paths: { pair: routes.pairPath, refresh: routes.refreshPath },
    accessJwt: () => call(tokenStore, 'jwt') as string | null,
    refreshToken: () => call(tokenStore, 'refreshToken') as string | null,
    async pair(code: string, post: WatchPost) {
      const view: Scope = {
        _submitting: true,
        _error: false,
        _entered: code,
        _index: 0,
        TokenStore: tokenStore,
        TickQueue: tickQueue,
        SessionLog: { reset() {} },
        Router: {
          toLoading() {
            effects.push('paired');
          },
        },
        WatchUi: { requestUpdate() {} },
      };
      replayAll(recording, 'views/PairingView.mc', ['onPairResult'], view);
      const reply = await post(routes.pairPath, routes.pairBody(code));
      call(view, 'onPairResult', reply.status, reply.body);
      return { ...reply, refused: view._error === true };
    },
    async refresh(post: WatchPost, queued = 1) {
      const refreshToken = call(tokenStore, 'refreshToken');
      if (typeof refreshToken !== 'string') throw new Error('Pre-G2 watch has no refresh token');
      const client: Scope = {
        _refreshing: true,
        _retryQueue: Array.from({ length: queued }, (_unused, index) => ({
          fire() {
            effects.push(`tick-${index}:resent`);
          },
          fail(code: number) {
            effects.push(`tick-${index}:failed:${code}`);
          },
        })),
        TokenStore: tokenStore,
        TickQueue: tickQueue,
        _onAuthLost: {
          invoke() {
            effects.push('auth-lost');
          },
        },
      };
      replayAll(
        recording,
        'net/BsClient.mc',
        ['_onRefreshFailed', '_failQueuedTransient', '_onRefreshResponse'],
        client,
      );
      const reply = await post(routes.refreshPath, routes.refreshBody(refreshToken));
      call(client, '_onRefreshResponse', reply.status, reply.body);
      return reply;
    },
  };
}
