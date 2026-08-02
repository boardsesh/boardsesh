// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeDiagnostics = vi.hoisted(() => ({
  markRootMounted: vi.fn(async () => {}),
  consume: vi.fn(),
}));

const sentryDiagnostics = vi.hoisted(() => ({
  capture: vi.fn(),
  enabled: true,
}));

const appState = vi.hoisted(() => {
  let currentState = 'active';
  const handlers = new Set<(state: string) => void>();
  const remove = vi.fn((handler: (state: string) => void) => handlers.delete(handler));
  return {
    getCurrentState: () => currentState,
    setState: (state: string) => {
      currentState = state;
    },
    emit: (state: string) => {
      currentState = state;
      for (const handler of handlers) handler(state);
    },
    addEventListener: vi.fn((_event: string, handler: (state: string) => void) => {
      handlers.add(handler);
      return { remove: vi.fn(() => remove(handler)) };
    }),
    remove,
    reset: () => {
      currentState = 'active';
      handlers.clear();
      remove.mockClear();
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.getCurrentState();
    },
    addEventListener: appState.addEventListener,
  },
}));

vi.mock('../../lib/live-activity/live-activity-plugin', () => ({
  markLiveActivityIntentReactRootMounted: nativeDiagnostics.markRootMounted,
  consumeInterruptedLiveActivityIntentRuns: nativeDiagnostics.consume,
}));

vi.mock('../../lib/sentry', () => ({
  captureLiveActivityIntentDiagnostic: sentryDiagnostics.capture,
  get isSentryEnabled() {
    return sentryDiagnostics.enabled;
  },
}));

import {
  consumeAndReportInterruptedLiveActivityIntents,
  LiveActivityIntentDiagnostics,
} from '../LiveActivityIntentDiagnostics';

const diagnostic = {
  schemaVersion: 1 as const,
  runId: '30fe8dab-7c3f-4ed0-ae20-291a87390001',
  processId: 'b5a82684-6a2c-4bbb-a9cc-b7bfc1df0001',
  intentKind: 'nextClimb' as const,
  appVersion: '2.0.0',
  buildNumber: '481',
  startedAtMs: 1_000,
  updatedAtMs: 3_000,
  lastStage: 'bleStarted' as const,
  reactRootMounted: true,
};

describe('LiveActivityIntentDiagnostics', () => {
  beforeEach(() => {
    appState.reset();
    appState.addEventListener.mockClear();
    nativeDiagnostics.markRootMounted.mockClear();
    nativeDiagnostics.markRootMounted.mockResolvedValue(undefined);
    nativeDiagnostics.consume.mockReset();
    nativeDiagnostics.consume.mockResolvedValue([]);
    sentryDiagnostics.capture.mockClear();
    sentryDiagnostics.enabled = true;
  });

  it('leaves the once-only store untouched when no Sentry reporter exists', async () => {
    sentryDiagnostics.enabled = false;
    nativeDiagnostics.consume.mockResolvedValueOnce([diagnostic]);

    await consumeAndReportInterruptedLiveActivityIntents();

    expect(nativeDiagnostics.consume).not.toHaveBeenCalled();
    expect(sentryDiagnostics.capture).not.toHaveBeenCalled();
  });

  it('reports each sanitized record returned by the once-only native consumer', async () => {
    const secondDiagnostic = { ...diagnostic, runId: '30fe8dab-7c3f-4ed0-ae20-291a87390002' };
    nativeDiagnostics.consume.mockResolvedValueOnce([diagnostic, secondDiagnostic]);

    await consumeAndReportInterruptedLiveActivityIntents();

    expect(sentryDiagnostics.capture).toHaveBeenNthCalledWith(1, diagnostic);
    expect(sentryDiagnostics.capture).toHaveBeenNthCalledWith(2, secondDiagnostic);
  });

  it('marks the root only after mount, then consumes while already foregrounded', async () => {
    expect(nativeDiagnostics.markRootMounted).not.toHaveBeenCalled();
    render(<LiveActivityIntentDiagnostics />);

    await waitFor(() => expect(nativeDiagnostics.markRootMounted).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(nativeDiagnostics.consume).toHaveBeenCalledTimes(1));
  });

  it('marks a background-launched React root without consuming until foreground', async () => {
    appState.setState('background');
    render(<LiveActivityIntentDiagnostics />);

    await waitFor(() => expect(nativeDiagnostics.markRootMounted).toHaveBeenCalledTimes(1));
    expect(nativeDiagnostics.consume).not.toHaveBeenCalled();

    appState.emit('active');
    await waitFor(() => expect(nativeDiagnostics.consume).toHaveBeenCalledTimes(1));
  });

  it('coalesces repeated foreground signals while native consumption is in flight', async () => {
    appState.setState('background');
    let resolveConsumption = (_diagnostics: Array<typeof diagnostic>) => {};
    nativeDiagnostics.consume.mockReturnValueOnce(
      new Promise<Array<typeof diagnostic>>((resolve) => {
        resolveConsumption = resolve;
      }),
    );
    render(<LiveActivityIntentDiagnostics />);
    await waitFor(() => expect(nativeDiagnostics.markRootMounted).toHaveBeenCalledTimes(1));

    appState.emit('active');
    appState.emit('active');
    expect(nativeDiagnostics.consume).toHaveBeenCalledTimes(1);

    await act(async () => resolveConsumption([]));
    appState.emit('active');
    await waitFor(() => expect(nativeDiagnostics.consume).toHaveBeenCalledTimes(2));
  });

  it('removes its foreground listener and ignores a late root marker after unmount', async () => {
    let resolveRootMarker = () => {};
    nativeDiagnostics.markRootMounted.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRootMarker = resolve;
      }),
    );
    const { unmount } = render(<LiveActivityIntentDiagnostics />);

    unmount();
    resolveRootMarker();
    await Promise.resolve();

    expect(appState.remove).toHaveBeenCalledTimes(1);
    expect(nativeDiagnostics.consume).not.toHaveBeenCalled();
  });
});
