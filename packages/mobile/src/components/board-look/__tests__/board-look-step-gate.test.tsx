// @vitest-environment jsdom
//
// The gate's plumbing, not its policy — the decision table itself is covered by
// board-look-step-decision.test.ts. What matters here is the two-pass shape: a
// climber who will never see the step must not pay for the example-climb query
// or the capability probe, and the step must be pushed at most once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const pushMock = vi.hoisted(() => vi.fn());
const segmentsCtrl = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));
const hasSeenTipMock = vi.hoisted(() => vi.fn());
const getInitialURLMock = vi.hoisted(() => vi.fn());
const ensureProbedMock = vi.hoisted(() => vi.fn());
const settingsCtrl = vi.hoisted(() => ({ mode: 'default' as string, loaded: true }));
const previewCtrl = vi.hoisted(() => ({ status: 'ready' as string, enabledCalls: [] as boolean[] }));
// The real probe latch notifies its subscribers when the answer lands; the mock
// keeps the listeners so a test can do the same.
const supportCtrl = vi.hoisted(() => ({
  value: true as boolean | null,
  listeners: new Set<() => void>(),
  answer(value: boolean) {
    supportCtrl.value = value;
    for (const listener of supportCtrl.listeners) listener();
  },
}));

vi.mock('expo-router', () => ({
  router: { push: pushMock },
  useSegments: () => segmentsCtrl.segments,
}));
vi.mock('expo-linking', () => ({ getInitialURL: getInitialURLMock }));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({ hasSeenTip: hasSeenTipMock }));
vi.mock('../../../lib/board-render-settings', () => ({
  useBoardRenderSettings: () => ({ settings: { mode: settingsCtrl.mode }, loaded: settingsCtrl.loaded }),
}));
vi.mock('../../../hooks/use-board-preview-climb', () => ({
  useBoardPreviewClimb: (enabled: boolean) => {
    previewCtrl.enabledCalls.push(enabled);
    return { status: previewCtrl.status, preview: null };
  },
}));
vi.mock('../../../hooks/use-native-climb-render', () => ({ ensureBoardseshSupportProbed: ensureProbedMock }));
vi.mock('../../../hooks/boardsesh-renderer-support', () => ({
  getBoardseshRendererSupport: () => supportCtrl.value,
  subscribeToBoardseshSupport: (listener: () => void) => {
    supportCtrl.listeners.add(listener);
    return () => supportCtrl.listeners.delete(listener);
  },
}));

const { BoardLookStepGate } = await import('../BoardLookStepGate');

beforeEach(() => {
  vi.clearAllMocks();
  segmentsCtrl.segments = ['(tabs)', 'climbs'];
  settingsCtrl.mode = 'default';
  settingsCtrl.loaded = true;
  previewCtrl.status = 'ready';
  previewCtrl.enabledCalls = [];
  supportCtrl.value = true;
  supportCtrl.listeners.clear();
  hasSeenTipMock.mockResolvedValue(false);
  getInitialURLMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe('BoardLookStepGate', () => {
  it('pushes the step for a climber who has never chosen a mode', async () => {
    render(<BoardLookStepGate ready tourDecided />);

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith({ pathname: '/onboarding', params: { step: 'board-look' } }),
    );
  });

  it('pushes at most once even as its inputs keep changing', async () => {
    const { rerender } = render(<BoardLookStepGate ready tourDecided />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));

    rerender(<BoardLookStepGate ready tourDecided />);
    segmentsCtrl.segments = ['(tabs)', 'profile'];
    rerender(<BoardLookStepGate ready tourDecided />);

    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the tour to finish before doing anything at all', () => {
    render(<BoardLookStepGate ready tourDecided={false} />);

    expect(pushMock).not.toHaveBeenCalled();
    expect(hasSeenTipMock).not.toHaveBeenCalled();
    // The expensive inputs stay disarmed while the tour still has its turn.
    expect(previewCtrl.enabledCalls.every((enabled) => !enabled)).toBe(true);
    expect(ensureProbedMock).not.toHaveBeenCalled();
  });

  describe('costs nothing for a climber who will never see it', () => {
    it('skips the flag read, the climb query and the probe when a mode was already chosen', () => {
      settingsCtrl.mode = 'classic';
      render(<BoardLookStepGate ready tourDecided />);

      expect(hasSeenTipMock).not.toHaveBeenCalled();
      expect(previewCtrl.enabledCalls.every((enabled) => !enabled)).toBe(true);
      expect(ensureProbedMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('skips them on a blocked route too', () => {
      segmentsCtrl.segments = ['boards'];
      render(<BoardLookStepGate ready tourDecided />);

      expect(previewCtrl.enabledCalls.every((enabled) => !enabled)).toBe(true);
      expect(ensureProbedMock).not.toHaveBeenCalled();
    });
  });

  it('forces the capability probe rather than waiting for a render to start it', async () => {
    // The step's whole audience sits on `mode: 'default'`, and nothing else on a
    // cold start necessarily asks for the Boardsesh drawing first — so without
    // this the probe could still be unanswered and every preview would fall
    // back to a classic render under a Boardsesh label.
    render(<BoardLookStepGate ready tourDecided />);

    await waitFor(() => expect(ensureProbedMock).toHaveBeenCalled());
  });

  it('holds while the probe has not answered, then pushes when it says yes', async () => {
    supportCtrl.value = null;
    render(<BoardLookStepGate ready tourDecided />);
    await waitFor(() => expect(ensureProbedMock).toHaveBeenCalled());
    // `null` reads as unavailable, and a step offered on an unverified library
    // would preview four classic renders under Boardsesh labels.
    expect(pushMock).not.toHaveBeenCalled();

    act(() => supportCtrl.answer(true));

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
  });

  it('never pushes when this build cannot draw the Boardsesh mode', async () => {
    supportCtrl.value = false;
    render(<BoardLookStepGate ready tourDecided />);

    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not cover a deep-link cold start', async () => {
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://climbs/abc');
    render(<BoardLookStepGate ready tourDecided />);

    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not push again once the step has been seen', async () => {
    hasSeenTipMock.mockResolvedValue(true);
    render(<BoardLookStepGate ready tourDecided />);

    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('holds a fresh install at "no board yet" rather than ruling it out', async () => {
    previewCtrl.status = 'loading';
    const { rerender } = render(<BoardLookStepGate ready tourDecided />);
    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();

    // They come back from the board picker with a board bound.
    previewCtrl.status = 'ready';
    rerender(<BoardLookStepGate ready tourDecided />);

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
  });
});
