import { describe, expect, it } from 'vitest';
import { AutoDisconnectController, AUTO_DISCONNECT_TIMEOUT_OPTIONS } from '../auto-disconnect-controller';

describe('AutoDisconnectController', () => {
  it('exposes the supported timeout choices', () => {
    expect(AUTO_DISCONNECT_TIMEOUT_OPTIONS).toEqual([10, 15, 30, 45, 60, 120, 300, 600]);
  });

  function harness() {
    let now = 0;
    let nextTimer = 0;
    const callbacks = new Map<number, () => void>();
    const expired: number[] = [];
    const controller = new AutoDisconnectController({
      now: () => now,
      setTimeout: (callback) => {
        const id = ++nextTimer;
        callbacks.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => callbacks.delete(timer as unknown as number),
      onExpire: () => expired.push(now),
    });
    return {
      controller,
      callbacks,
      expired,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it('expires once when enabled and connected', () => {
    const test = harness();
    test.controller.update(true, 30);
    test.controller.connectedNow();
    expect(test.controller.getDeadlineMs()).toBe(30_000);
    const callback = [...test.callbacks.values()][0];
    test.advance(30_000);
    callback();
    expect(test.expired).toEqual([30_000]);
    callback();
    expect(test.expired).toEqual([30_000]);
  });

  it('invalidates an old callback across the disconnect/reconnect race', () => {
    const test = harness();
    test.controller.update(true, 10);
    test.controller.connectedNow();
    const oldCallback = [...test.callbacks.values()][0];
    test.controller.disconnectedNow();
    test.controller.connectedNow();
    const newCallback = [...test.callbacks.values()][0];

    oldCallback();
    expect(test.expired).toEqual([]);
    test.advance(10_000);
    newCallback();
    expect(test.expired).toEqual([10_000]);
  });

  it('resets and resumes from the wall-clock deadline', () => {
    const test = harness();
    test.controller.update(true, 30);
    test.controller.connectedNow();
    test.advance(20_000);
    test.controller.reset();
    expect(test.controller.getDeadlineMs()).toBe(50_000);
    test.advance(29_999);
    test.controller.resume();
    expect(test.expired).toEqual([]);
    test.advance(1);
    test.controller.resume();
    expect(test.expired).toEqual([50_000]);
  });

  it('cancels on disable and timeout changes start a fresh deadline', () => {
    const test = harness();
    test.controller.update(true, 30);
    test.controller.connectedNow();
    const oldCallback = [...test.callbacks.values()][0];
    test.controller.update(false, 60);
    oldCallback();
    expect(test.expired).toEqual([]);

    test.controller.update(true, 60);
    test.controller.connectedNow();
    expect(test.controller.getDeadlineMs()).toBe(60_000);
  });
});
