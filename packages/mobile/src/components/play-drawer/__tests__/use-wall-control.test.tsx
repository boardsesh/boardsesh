// @vitest-environment jsdom
// The one handler behind every view of the board control (#7000): each tap
// action runs its runner, a hold opens the board sheet only with a link, and
// each event fires once with the view that was used.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ tapped: vi.fn(), shown: vi.fn(), opened: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticMedium: vi.fn(), hapticWarning: vi.fn() }));
const announceQueued = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackWallControlTapped: analytics.tapped,
  trackWallControlShown: analytics.shown,
}));
vi.mock('../../../lib/analytics-board-connect', () => ({ trackBoardControlsOpened: analytics.opened }));
vi.mock('../../../lib/haptics', () => haptics);
vi.mock('../../../lib/announce-queued', () => ({ announceQueued }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { DISCONNECT_TAP_GUARD_MS, useWallControl, type WallControlRunners } from '../use-wall-control';
import { EMPTY_WALL_CONTROL, type WallControlAction, type WallControlModel } from '../wall-control';

type MockRunners = { [Name in keyof WallControlRunners]: ReturnType<typeof vi.fn<() => void>> };

function runners(): MockRunners {
  return {
    light: vi.fn<() => void>(),
    toggle: vi.fn<() => void>(),
    disconnect: vi.fn<() => void>(),
    openSheet: vi.fn<() => void>(),
    lightAgain: vi.fn<() => void>(),
    moveToBoard: vi.fn<() => void>(),
  };
}

function setup(model: WallControlModel, run = runners(), visible = true) {
  const hook = renderHook(
    (props: { model: WallControlModel; linked?: boolean }) =>
      useWallControl({
        model: props.model,
        runners: run,
        climbUuid: 'climb-1',
        playerOpen: true,
        visible,
        linked: props.linked ?? true,
      }),
    { initialProps: { model } as { model: WallControlModel; linked?: boolean } },
  );
  return { hook, run };
}

const modelFor = (
  state: WallControlModel['state'],
  tapAction: WallControlAction,
  extra: Partial<WallControlModel> = {},
) => ({ ...EMPTY_WALL_CONTROL, state, tapAction, ...extra }) as WallControlModel;

describe('useWallControl', () => {
  beforeEach(() => {
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });

  it.each([
    ['connect', 'connect', 'light'],
    ['put_on_wall', 'put_on_wall', 'light'],
    ['dark', 'relight', 'light'],
    ['crew', 'relay', 'toggle'],
    ['take_wall', 'take_wall', 'toggle'],
    ['release_wall', 'release_wall', 'toggle'],
    ['lit', 'disconnect', 'disconnect'],
  ] as const)('a tap on %s runs %s through %s, and logs it once', (state, action, runner) => {
    const { hook, run } = setup(modelFor(state, action));
    act(() => hook.result.current.press('button'));
    expect(run[runner]).toHaveBeenCalledOnce();
    for (const other of (['light', 'toggle', 'disconnect', 'openSheet'] as const).filter((name) => name !== runner)) {
      expect(run[other]).not.toHaveBeenCalled();
    }
    expect(analytics.tapped).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state, action, control: 'button' });
  });

  it('lets go of the board with a warning buzz, and says so once the link drops', () => {
    const { hook } = setup(modelFor('lit', 'disconnect'));
    act(() => hook.result.current.press('bulb'));
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'disconnect', control: 'bulb' });
    // Not at the tap: the disconnect could still fail.
    expect(announceQueued).not.toHaveBeenCalled();

    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).toHaveBeenCalledOnce();
    expect(announceQueued).toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
  });

  it('says nothing when the link drops without a tap-disconnect (auto-disconnect, the sheet)', () => {
    const { hook } = setup(modelFor('lit', 'disconnect'));
    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).not.toHaveBeenCalled();
  });

  // Fable review: the provider marks the link down before the adapter lets go,
  // so a double tap's second tap read Connect board and started a connect.
  it('turns a double tap on You have the board into one disconnect and no connect', () => {
    vi.useFakeTimers();
    try {
      const { hook, run } = setup(modelFor('lit', 'disconnect'));
      act(() => hook.result.current.press('button'));
      // The link already reads down: the model says Connect board.
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).toHaveBeenCalledOnce();
      expect(run.light).not.toHaveBeenCalled();
      expect(analytics.tapped).toHaveBeenCalledOnce();

      // A deliberate tap after the guard connects again.
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
      act(() => hook.result.current.press('button'));
      expect(run.light).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a noop tap but runs nothing, and ignores a tap while a connect is in flight', () => {
    const { hook, run } = setup(modelFor('lit', 'noop'));
    act(() => hook.result.current.press('mini_bar'));
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'noop', control: 'mini_bar' });
    expect(Object.values(run).some((runner) => runner.mock.calls.length > 0)).toBe(false);

    analytics.tapped.mockClear();
    hook.rerender({ model: modelFor('connect', 'connect', { pending: true }) });
    act(() => hook.result.current.press('button'));
    expect(analytics.tapped).not.toHaveBeenCalled();
    expect(run.light).not.toHaveBeenCalled();
  });

  it('opens the board sheet on a hold while this phone holds the link, saying which view', () => {
    const { hook, run } = setup(modelFor('lit', 'disconnect', { longPress: 'sheet' }));
    act(() => hook.result.current.longPress('mini_bar'));
    expect(run.openSheet).toHaveBeenCalledOnce();
    expect(analytics.opened).toHaveBeenCalledWith({ surface: 'play_drawer', source: 'mini_bar' });
    expect(run.disconnect).not.toHaveBeenCalled();
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it('does nothing on a hold without a link', () => {
    const { hook, run } = setup(modelFor('connect', 'connect'));
    act(() => hook.result.current.longPress('button'));
    expect(run.openSheet).not.toHaveBeenCalled();
    expect(analytics.opened).not.toHaveBeenCalled();
  });

  it('keeps its handlers across renders and acts on the latest model', () => {
    const { hook, run } = setup(modelFor('connect', 'connect'));
    const first = hook.result.current;
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    expect(hook.result.current.press).toBe(first.press);
    act(() => first.press('button'));
    expect(run.disconnect).toHaveBeenCalledOnce();
    expect(run.light).not.toHaveBeenCalled();
  });

  it('counts Wall Control Shown for the control that asks, once', () => {
    const { hook } = setup(modelFor('connect', 'connect'));
    hook.rerender({ model: modelFor('connect', 'connect') });
    expect(analytics.shown).toHaveBeenCalledOnce();
    expect(analytics.shown).toHaveBeenCalledWith({ state: 'connect', climbUuid: 'climb-1' });
  });
});
