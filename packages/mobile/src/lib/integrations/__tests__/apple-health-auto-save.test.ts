import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionHealthExport, SessionSummary } from '@boardsesh/shared-schema';

// ── Mock native module, preference store, analytics, graphql client ──────────
// `vi.hoisted` is required: bare `vi.mock` factories are hoisted above top-level
// `const`s, so every mock fn referenced inside a factory must be created in a
// hoisted block to be in scope when the factory runs.
const {
  isAvailableMock,
  getAuthorizationStatusMock,
  requestAuthorizationMock,
  saveWorkoutMock,
  getPreferenceMock,
  setPreferenceMock,
  trackMock,
  requestMock,
} = vi.hoisted(() => ({
  isAvailableMock: vi.fn(),
  getAuthorizationStatusMock: vi.fn(),
  requestAuthorizationMock: vi.fn(),
  saveWorkoutMock: vi.fn(),
  getPreferenceMock: vi.fn(),
  setPreferenceMock: vi.fn(),
  trackMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock('../../../../modules/health-workouts/src/index', () => ({
  healthWorkoutsNative: {
    isAvailable: () => isAvailableMock(),
    getAuthorizationStatus: () => getAuthorizationStatusMock(),
    requestAuthorization: () => requestAuthorizationMock(),
    saveWorkout: (options: unknown) => saveWorkoutMock(options),
  },
}));

vi.mock('../../preference-store', () => ({
  getPreference: (key: string) => getPreferenceMock(key),
  setPreference: (key: string, value: unknown) => setPreferenceMock(key, value),
}));

vi.mock('../../analytics', () => ({ track: trackMock }));

vi.mock('../../graphql/client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

vi.mock('@boardsesh/graphql/operations/activity-feed', () => ({
  SET_SESSION_HEALTHKIT_WORKOUT_ID: 'SET_SESSION_HEALTHKIT_WORKOUT_ID',
}));

import { autoSaveToAppleHealth, manualSaveToAppleHealth, _resetHealthKitSaveStateForTests } from '../apple-health';
import type { SessionExportContext } from '../types';

const makeSummary = (overrides?: Partial<SessionSummary>): SessionSummary => ({
  sessionId: 'session-1',
  totalSends: 5,
  totalFlashes: 2,
  totalAttempts: 10,
  gradeDistribution: [],
  participants: [],
  startedAt: '2026-04-20T10:00:00Z',
  endedAt: '2026-04-20T11:00:00Z',
  durationMinutes: 60,
  goal: null,
  ...overrides,
});

const makeHealthExport = (overrides?: Partial<SessionHealthExport>): SessionHealthExport => ({
  sessionId: 'session-1',
  totalSends: 5,
  totalAttempts: 10,
  boardType: 'kilter',
  laps: [
    {
      tickUuid: 'tick-1',
      climbedAt: '2026-04-20T10:30:00Z',
      climbUuid: 'climb-1',
      climbName: 'Test Climb',
      grade: 'V5',
      status: 'send',
      attemptCount: 2,
      boardType: 'kilter',
      angle: 40,
    },
  ],
  hardestClimb: {
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    grade: 'V5',
  },
  startedAt: '2026-04-20T10:00:00Z',
  endedAt: '2026-04-20T11:00:00Z',
  durationMinutes: 60,
  healthKitWorkoutId: null,
  ...overrides,
});

const ctx: SessionExportContext = {};

// Default-ON preference: only an explicit `false` disables. Tests that need it
// off override getPreferenceMock per case.
function autoSaveOn() {
  getPreferenceMock.mockResolvedValue(null);
}

function mockGraphqlResponses(healthExport: SessionHealthExport | null = makeHealthExport()) {
  requestMock.mockImplementation(async (operation: unknown, variables?: { sessionId?: string; workoutId?: string }) => {
    if (operation === 'SET_SESSION_HEALTHKIT_WORKOUT_ID') return {};
    return {
      sessionHealthExport: healthExport
        ? {
            ...healthExport,
            sessionId: variables?.sessionId ?? healthExport.sessionId,
          }
        : null,
    };
  });
}

describe('autoSaveToAppleHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHealthKitSaveStateForTests();
    // Sensible happy-path defaults; individual tests override.
    autoSaveOn();
    isAvailableMock.mockResolvedValue({ available: true });
    getAuthorizationStatusMock.mockResolvedValue({ status: 'authorized' });
    requestAuthorizationMock.mockResolvedValue({ granted: true });
    saveWorkoutMock.mockResolvedValue({
      workoutId: 'hk-workout-1',
      created: true,
      energyKilocalories: 100,
      energySaved: true,
      lapCount: 1,
    });
    mockGraphqlResponses();
  });

  it('skips and releases the guard when auto-save preference is off', async () => {
    getPreferenceMock.mockImplementation(async (key: string) => (key === 'appleHealthAutoSave' ? false : null));

    const result = await autoSaveToAppleHealth(makeSummary({ sessionId: 'pref-off' }), ctx);

    expect(result).toBeNull();
    expect(isAvailableMock).not.toHaveBeenCalled();
    // Guard released → a manual retry can proceed.
    const retry = await manualSaveToAppleHealth(makeSummary({ sessionId: 'pref-off' }), ctx);
    expect(retry).toBe('saved');
  });

  it('skips when HealthKit is unavailable', async () => {
    isAvailableMock.mockResolvedValue({ available: false });

    const result = await autoSaveToAppleHealth(makeSummary({ sessionId: 'unavailable' }), ctx);

    expect(result).toBeNull();
    expect(requestMock).toHaveBeenCalled();
    expect(requestAuthorizationMock).not.toHaveBeenCalled();
  });

  it('skips and releases the guard when authorization is denied (manual retry works)', async () => {
    getAuthorizationStatusMock.mockResolvedValueOnce({ status: 'denied' });

    const result = await autoSaveToAppleHealth(makeSummary({ sessionId: 'denied' }), ctx);

    expect(result).toBeNull();
    expect(saveWorkoutMock).not.toHaveBeenCalled();
    // A decided user must never get another consent-sheet request.
    expect(requestAuthorizationMock).not.toHaveBeenCalled();

    // Guard was released; a manual retry (auth now granted) saves.
    getAuthorizationStatusMock.mockResolvedValueOnce({ status: 'authorized' });
    const retry = await manualSaveToAppleHealth(makeSummary({ sessionId: 'denied' }), ctx);
    expect(retry).toBe('saved');
  });

  it('prompts exactly once for an undecided user, then saves on grant', async () => {
    getAuthorizationStatusMock.mockResolvedValueOnce({ status: 'notDetermined' });
    requestAuthorizationMock.mockResolvedValueOnce({ granted: true });

    const result = await autoSaveToAppleHealth(makeSummary({ sessionId: 'undecided' }), ctx);

    expect(result).toBe('hk-workout-1');
    expect(requestAuthorizationMock).toHaveBeenCalledTimes(1);
  });

  it('saves once, persists the workout id, and marks state saved', async () => {
    saveWorkoutMock.mockResolvedValue({
      workoutId: 'hk-workout-7',
      created: true,
      energyKilocalories: 120,
      energySaved: true,
      lapCount: 1,
    });

    const result = await autoSaveToAppleHealth(makeSummary(), ctx);

    expect(result).toBe('hk-workout-7');
    expect(saveWorkoutMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('SET_SESSION_HEALTHKIT_WORKOUT_ID', {
      sessionId: 'session-1',
      workoutId: 'hk-workout-7',
    });
    expect(saveWorkoutMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      startDate: '2026-04-20T10:00:00Z',
      endDate: '2026-04-20T11:00:00Z',
      totalSends: 5,
      totalAttempts: 10,
      hardestGrade: 'V5',
      boardType: 'kilter',
      laps: makeHealthExport().laps,
    });
    expect(trackMock).toHaveBeenCalledWith('Session Exported to Integration', {
      integration: 'apple_health',
      trigger: 'auto',
    });
  });

  it('still resolves saved when the backend persist fails', async () => {
    saveWorkoutMock.mockResolvedValue({
      workoutId: 'hk-workout-8',
      created: true,
      energyKilocalories: 110,
      energySaved: true,
      lapCount: 1,
    });
    requestMock.mockImplementation(async (operation: unknown, variables?: { sessionId?: string }) => {
      if (operation === 'SET_SESSION_HEALTHKIT_WORKOUT_ID') throw new Error('network error');
      return { sessionHealthExport: { ...makeHealthExport(), sessionId: variables?.sessionId ?? 'session-1' } };
    });

    const result = await autoSaveToAppleHealth(makeSummary(), ctx);

    expect(result).toBe('hk-workout-8');
  });

  it('marks state failed when the native save throws, then a manual retry proceeds', async () => {
    saveWorkoutMock.mockRejectedValueOnce(new Error('save crashed'));

    const first = await autoSaveToAppleHealth(makeSummary({ sessionId: 'retry' }), ctx);
    expect(first).toBeNull();

    // 'failed' is retryable: a manual save overwrites it and succeeds.
    saveWorkoutMock.mockResolvedValueOnce({
      workoutId: 'hk-workout-retry',
      created: true,
      energyKilocalories: 100,
      energySaved: true,
      lapCount: 1,
    });
    const retry = await manualSaveToAppleHealth(makeSummary({ sessionId: 'retry' }), ctx);
    expect(retry).toBe('saved');
    expect(saveWorkoutMock).toHaveBeenCalledTimes(2);
  });

  it('skips and releases the guard when the health export lacks start/end timestamps', async () => {
    const result = await autoSaveToAppleHealth(makeSummary({ sessionId: 'no-dates' }), {
      healthExport: makeHealthExport({ sessionId: 'no-dates', startedAt: null, endedAt: null }),
    });

    expect(result).toBeNull();
    expect(saveWorkoutMock).not.toHaveBeenCalled();
  });

  it('marks saved without prompting when the backend already has a workout id', async () => {
    mockGraphqlResponses(makeHealthExport({ healthKitWorkoutId: 'hk-existing' }));

    const result = await autoSaveToAppleHealth(makeSummary({ sessionId: 'existing' }), ctx);

    expect(result).toBe('hk-existing');
    expect(isAvailableMock).not.toHaveBeenCalled();
    expect(requestAuthorizationMock).not.toHaveBeenCalled();
    expect(saveWorkoutMock).not.toHaveBeenCalled();
  });

  it('keeps the saved state distinct when active-energy was not written', async () => {
    saveWorkoutMock.mockResolvedValueOnce({
      workoutId: 'hk-without-energy',
      created: true,
      energyKilocalories: 100,
      energySaved: false,
      lapCount: 1,
    });

    const result = await manualSaveToAppleHealth(makeSummary({ sessionId: 'no-energy' }), ctx);

    expect(result).toBe('savedWithoutEnergy');
    expect(await manualSaveToAppleHealth(makeSummary({ sessionId: 'no-energy' }), ctx)).toBe('savedWithoutEnergy');
    expect(saveWorkoutMock).toHaveBeenCalledTimes(1);
  });

  it('runs the native save once under concurrent auto + manual', async () => {
    saveWorkoutMock.mockResolvedValue({
      workoutId: 'hk-workout-concurrent',
      created: true,
      energyKilocalories: 100,
      energySaved: true,
      lapCount: 1,
    });

    const summary = makeSummary({ sessionId: 'concurrent' });
    const [autoResult, manualResult] = await Promise.all([
      autoSaveToAppleHealth(summary, ctx),
      manualSaveToAppleHealth(summary, ctx),
    ]);

    // Auto claims 'saving' synchronously first; the manual call observes the
    // in-flight claim and bails with 'inFlight' — NOT 'saved', since the
    // running auto-save may yet fail — without a second native write.
    expect(saveWorkoutMock).toHaveBeenCalledTimes(1);
    expect(autoResult).toBe('hk-workout-concurrent');
    expect(manualResult).toBe('inFlight');
  });
});
