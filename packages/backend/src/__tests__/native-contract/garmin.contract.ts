import { describe, expect, it } from 'vite-plus/test';
import { recordings } from './recordings';
import { garminFunction } from './garmin-source';

/** The shape of a minted device token: `v1.<22-char id>.<epoch seconds>.<43-char MAC>`. */
const DEVICE_TOKEN_SHAPE = `v1.${'A'.repeat(22)}.1795000000.${'B'.repeat(43)}`;

for (const recording of recordings.garmin) {
  const g2 = recording.name === 'g2-reviewed';
  describe(`recorded Garmin source replay: ${recording.name}`, () => {
    it('pins the final G2 checkpoint and preserves an explicit source-only claim', () => {
      expect(recordings.evidence).toBe('git-source-only; installs and OTA coverage unproven');
      if (g2) expect(recording.commit).toBe('73e85b88102caeed139f5df8ee0db3517f227cd4');
      expect(recording.modules['garmin/source/views/PairingView.mc']).toBeDefined();
      expect(recording.modules['garmin/source/views/LoadingView.mc']).toBeDefined();
    });
    // The last case is today's 200 reply with the additive `deviceToken` (#7656):
    // the recorded watch must branch on it exactly as on the reply without it.
    const refreshCases = [
      ...[200, 400, 401, 403, 404, 429, 500, 503, -1].map((status) => ({ status, deviceToken: false })),
      { status: 200, deviceToken: true },
    ];
    for (const { status, deviceToken } of refreshCases) {
      it(`executes actual refresh completion branching for ${status}${deviceToken ? ' with a device token' : ''}`, () => {
        const effects: string[] = [];
        const requests = [
          {
            fire() {
              effects.push('retry');
            },
            fail(code: number) {
              effects.push(`failed:${code}`);
            },
          },
        ];
        const scope: Record<string, unknown> = {
          _refreshing: true,
          _retryQueue: requests,
          TokenStore: {
            store() {
              effects.push('stored');
            },
            clear() {
              effects.push('cleared');
            },
            currentRevision: () => true,
            acceptRotation: (_pending: unknown, reply: unknown) => status === 200 && reply !== null,
            snapshot: () => ({ owner: 'fixture-owner' }),
            replace: () => true,
          },
          TickQueue: {
            clear() {
              effects.push('ticks-cleared');
            },
          },
          _onAuthLost: {
            invoke() {
              effects.push('auth-lost');
            },
          },
          _authLost() {
            effects.push('auth-lost');
          },
          BsResponse: { STALE: -32001 },
          AuthState: { resumeUnconsumed: (pending: unknown) => pending },
          BsRefreshPolicy: { provenUnconsumed: () => false },
          _flight: null,
        };
        // The server's real success shape: AuthState.responseValid requires userId.
        const payload =
          status === 200
            ? {
                userId: 'fixture-owner',
                jwt: 'fixture-jwt',
                refreshToken: 'fixture-refresh',
                expiresAt: '2099-01-01T00:00:00Z',
                ...(deviceToken ? { deviceToken: DEVICE_TOKEN_SHAPE } : {}),
              }
            : { error: 'ambiguous fixture response' };
        if (!g2) {
          scope._onRefreshFailed = garminFunction(recording, 'net/BsClient.mc', '_onRefreshFailed', scope);
          scope._failQueuedTransient = garminFunction(recording, 'net/BsClient.mc', '_failQueuedTransient', scope);
          garminFunction(recording, 'net/BsClient.mc', '_onRefreshResponse', scope)(status, payload);
          const definitive = status >= 400 && status < 500 && status !== 429;
          expect(effects.includes('cleared')).toBe(definitive);
          expect(effects.includes('ticks-cleared')).toBe(definitive);
          expect(effects.includes('auth-lost')).toBe(definitive);
          if (status === 200) expect(effects).toEqual(['stored', 'retry']);
          else expect(effects).toContain(`failed:${definitive ? 401 : status}`);
        } else {
          scope.Communications = { BLE_CONNECTION_UNAVAILABLE: -101, BLE_QUEUE_FULL: -102 };
          scope.BsRefreshPolicy = {
            provenUnconsumed: garminFunction(recording, 'net/BsClient.mc', 'provenUnconsumed', scope),
          };
          const flight = {
            finish(code: number, replacement: unknown) {
              effects.push(`${code}:${replacement ? 'retry' : 'refused'}`);
            },
          };
          scope._flight = flight;
          garminFunction(recording, 'net/BsClient.mc', 'refreshFinished', scope)(
            flight,
            { owner: 'fixture-owner' },
            status,
            payload,
          );
          const definitive = status >= 400 && status < 500 && status !== 429;
          expect(effects.includes('cleared')).toBe(definitive);
          expect(effects.includes('auth-lost')).toBe(definitive);
          expect(effects).toContain(`${status}:${status === 200 ? 'retry' : 'refused'}`);
        }
      });
    }
    it('executes PairingView success and failure consumers', () => {
      const effects: string[] = [];
      const scope = {
        _submitting: true,
        _error: false,
        _entered: 'ABCDEFGH',
        _index: 7,
        _attempt: {},
        BsResponse: { STALE: -32001 },
        AuthState: { sameRevision: () => true },
        TokenStore: {
          currentRevision: () => true,
          acceptPair: () => true,
          store() {
            effects.push('stored');
          },
        },
        TickQueue: {
          clear() {
            effects.push('ticks-cleared');
          },
        },
        SessionLog: {
          reset() {
            effects.push('session-reset');
          },
        },
        Router: {
          toLoading() {
            effects.push('loading');
          },
        },
        WatchUi: {
          requestUpdate() {
            effects.push('render');
          },
        },
      };
      const pairResult = garminFunction(recording, 'views/PairingView.mc', 'onPairResult', scope);
      pairResult(
        200,
        {
          userId: 'fixture-owner',
          jwt: 'fixture-jwt',
          refreshToken: 'fixture-refresh',
          expiresAt: '2099-01-01T00:00:00Z',
        },
        {},
      );
      expect(effects).toContain('loading');
      effects.length = 0;
      pairResult(503, null, {});
      expect(effects).toEqual(['render']);
      expect(scope._entered).toBe('');
      expect(scope._error).toBe(true);
    });
    it('executes LoadingView retry, auth-refusal and session routing consumers', () => {
      const effects: string[] = [];
      const scope = {
        BsResponse: { STALE: -32001 },
        TokenStore: { current: () => true },
        AppState: { authContext: null, activeSessions: (sessions: unknown) => sessions },
        Router: {
          toNoSession() {
            effects.push('retry');
          },
          toClimb() {
            effects.push('climb');
          },
          toSessionPicker() {
            effects.push('picker');
          },
        },
        _attach() {
          effects.push('attach');
        },
        showNoSession() {
          effects.push('retry');
        },
      };
      const sessions = garminFunction(recording, 'views/LoadingView.mc', 'onSessions', scope);
      sessions(401, null, {});
      expect(effects).toEqual([]);
      sessions(503, null, {});
      sessions(200, [], {});
      sessions(200, [{ id: 'fixture-session' }], {});
      sessions(200, [{ id: 'fixture-session-a' }, { id: 'fixture-session-b' }], {});
      expect(effects).toEqual(['retry', 'retry', 'attach', 'climb', 'picker']);
    });
  });
}
