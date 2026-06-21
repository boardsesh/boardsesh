import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionSummary } from '@boardsesh/shared-schema';

// `vi.hoisted` so these are in scope when the hoisted `vi.mock` factories run.
// Mutable Platform mock — flip platformOS.value per test before exercising the
// registry (isSupported reads Platform.OS at call time). autoSaveMock makes the
// registry's autoExportOnSessionEnd fully controllable (no native bridge /
// analytics / graphql).
const { platformOS, autoSaveMock } = vi.hoisted(() => ({
  platformOS: { value: 'ios' as 'ios' | 'android' },
  autoSaveMock: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformOS.value;
    },
  },
}));

vi.mock('../apple-health', () => ({
  autoSaveToAppleHealth: (summary: unknown, ctx: unknown) => autoSaveMock(summary, ctx),
}));

import { getSupportedIntegrations, runSessionEndExports, INTEGRATIONS } from '../registry';

const summary: SessionSummary = {
  sessionId: 'session-1',
  totalSends: 1,
  totalFlashes: 0,
  totalAttempts: 2,
  gradeDistribution: [],
  participants: [],
  startedAt: '2026-04-20T10:00:00Z',
  endedAt: '2026-04-20T11:00:00Z',
  durationMinutes: 60,
  goal: null,
};

const ctx = {};

describe('integration registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoSaveMock.mockResolvedValue('hk-workout-1');
  });

  it('excludes apple-health on android', () => {
    platformOS.value = 'android';
    const ids = getSupportedIntegrations().map((integration) => integration.id);
    expect(ids).not.toContain('apple-health');
    // Strava is always supported.
    expect(ids).toContain('strava');
  });

  it('includes apple-health on ios', () => {
    platformOS.value = 'ios';
    const ids = getSupportedIntegrations().map((integration) => integration.id);
    expect(ids).toContain('apple-health');
    expect(ids).toContain('strava');
  });

  it('keeps strava as a platform integration with no on-device auto-export', () => {
    const strava = INTEGRATIONS.find((integration) => integration.id === 'strava');
    expect(strava?.kind).toBe('platform');
    expect(strava?.autoExportOnSessionEnd).toBeUndefined();
  });

  it('runs the apple-health export on session end (ios)', () => {
    platformOS.value = 'ios';
    runSessionEndExports(summary, ctx);
    expect(autoSaveMock).toHaveBeenCalledWith(summary, ctx);
  });

  describe('rejection handling', () => {
    let unhandled: unknown[];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    beforeEach(() => {
      unhandled = [];
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    it('swallows a rejecting exporter (no unhandled rejection)', async () => {
      platformOS.value = 'ios';
      autoSaveMock.mockRejectedValue(new Error('export blew up'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Fire-and-forget; returns void synchronously and must not throw.
      expect(() => runSessionEndExports(summary, ctx)).not.toThrow();

      // Let the rejected promise + its .catch settle, then a macrotask so any
      // would-be unhandledRejection has a chance to fire.
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
