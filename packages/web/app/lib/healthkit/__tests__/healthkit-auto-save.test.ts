import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { autoSaveToHealthKit, _resetAutoSaveGuard, isSessionSavedOrInFlight } from '../healthkit-auto-save';
import {
  getHealthKitAutoSync,
  isHealthKitAvailable,
  requestHealthKitAuthorization,
  saveSessionToHealthKit,
} from '../healthkit-bridge';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

// Mock dependencies
vi.mock('../healthkit-bridge', () => ({
  getHealthKitAutoSync: vi.fn(),
  isHealthKitAvailable: vi.fn(),
  requestHealthKitAuthorization: vi.fn(),
  saveSessionToHealthKit: vi.fn(),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(),
}));

vi.mock('@boardsesh/graphql/operations/activity-feed', () => ({
  SET_SESSION_HEALTHKIT_WORKOUT_ID: 'SET_SESSION_HEALTHKIT_WORKOUT_ID',
}));

const mockGetAutoSync = vi.mocked(getHealthKitAutoSync);
const mockIsAvailable = vi.mocked(isHealthKitAvailable);
const mockRequestAuth = vi.mocked(requestHealthKitAuthorization);
const mockSaveSession = vi.mocked(saveSessionToHealthKit);
const mockCreateClient = vi.mocked(createGraphQLHttpClient);

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

describe('autoSaveToHealthKit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAutoSaveGuard();
  });

  it('returns null when auto-sync is disabled', async () => {
    mockGetAutoSync.mockResolvedValue(false);

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', 'token');

    expect(result).toBeNull();
    expect(mockIsAvailable).not.toHaveBeenCalled();
  });

  it('does not add to guard when auto-sync is disabled', async () => {
    mockGetAutoSync.mockResolvedValue(false);

    const summary = makeSummary({ sessionId: 'auto-sync-off' });
    await autoSaveToHealthKit(summary, 'kilter', 'token');

    expect(isSessionSavedOrInFlight('auto-sync-off')).toBe(false);
  });

  it('does not add to guard when HealthKit is unavailable', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(false);

    const summary = makeSummary({ sessionId: 'unavailable' });
    await autoSaveToHealthKit(summary, 'kilter', 'token');

    expect(isSessionSavedOrInFlight('unavailable')).toBe(false);
  });

  it('returns null when HealthKit is unavailable', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(false);

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', 'token');

    expect(result).toBeNull();
    expect(mockRequestAuth).not.toHaveBeenCalled();
  });

  it('returns null when authorization is denied', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(false);

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', 'token');

    expect(result).toBeNull();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('returns null when saveSessionToHealthKit fails', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(true);
    mockSaveSession.mockResolvedValue(null);

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', 'token');

    expect(result).toBeNull();
  });

  it('returns workoutId on successful save and persists to backend', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(true);
    mockSaveSession.mockResolvedValue({ workoutId: 'hk-workout-1' });
    const mockRequest = vi.fn().mockResolvedValue({});
    mockCreateClient.mockReturnValue({ request: mockRequest } as never);

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', 'token');

    expect(result).toBe('hk-workout-1');
    expect(mockRequest).toHaveBeenCalledWith('SET_SESSION_HEALTHKIT_WORKOUT_ID', {
      sessionId: 'session-1',
      workoutId: 'hk-workout-1',
    });
  });

  it('returns workoutId even when backend persist fails', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(true);
    mockSaveSession.mockResolvedValue({ workoutId: 'hk-workout-2' });
    const mockRequest = vi.fn().mockRejectedValue(new Error('network error'));
    mockCreateClient.mockReturnValue({ request: mockRequest } as never);

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', 'token');

    expect(result).toBe('hk-workout-2');
  });

  it('skips backend persist when authToken is null', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(true);
    mockSaveSession.mockResolvedValue({ workoutId: 'hk-workout-3' });

    const result = await autoSaveToHealthKit(makeSummary(), 'kilter', null);

    expect(result).toBe('hk-workout-3');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('prevents duplicate saves for the same session', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(true);
    mockSaveSession.mockResolvedValue({ workoutId: 'hk-workout-4' });
    mockCreateClient.mockReturnValue({ request: vi.fn().mockResolvedValue({}) } as never);

    const summary = makeSummary();
    const first = await autoSaveToHealthKit(summary, 'kilter', 'token');
    const second = await autoSaveToHealthKit(summary, 'kilter', 'token');

    expect(first).toBe('hk-workout-4');
    expect(second).toBeNull();
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a genuine failure', async () => {
    mockGetAutoSync.mockResolvedValue(true);
    mockIsAvailable.mockResolvedValue(true);
    mockRequestAuth.mockResolvedValue(true);
    // First call throws
    mockSaveSession.mockRejectedValueOnce(new Error('crash'));
    // Second call succeeds
    mockSaveSession.mockResolvedValueOnce({ workoutId: 'hk-workout-5' });
    mockCreateClient.mockReturnValue({ request: vi.fn().mockResolvedValue({}) } as never);

    const summary = makeSummary({ sessionId: 'retry-session' });
    const first = await autoSaveToHealthKit(summary, 'kilter', 'token');
    const second = await autoSaveToHealthKit(summary, 'kilter', 'token');

    expect(first).toBeNull();
    expect(second).toBe('hk-workout-5');
  });
});
