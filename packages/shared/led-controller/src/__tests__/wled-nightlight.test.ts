import { describe, expect, it, vi } from 'vitest';
import { createLedPreviewSession } from '../preview';
import { createWledDriver } from '../wled';

/**
 * A WLED controller as far as auto-off is concerned, following v0.15.0 / 16.0.1:
 * a JSON request only sets `nightlightActive` (json.cpp `deserializeState`), and
 * `handleNightlight` (led.cpp), at most every 100 ms and never inside a request,
 * starts a countdown when it first sees the flag on and forgets one when it sees
 * it off. In mode 0 the countdown ends by setting the brightness to `tbri`.
 */
function firmware({ ledCount = 300 }: { ledCount?: number } = {}) {
  const info = { ledCount };
  let now = 0;
  let lastTick = -1000;
  let stalledTicks = 0;
  const wall = { bri: 128, briLast: 128, segments: [0, 3] };
  const nl = { active: false, old: false, start: 0, delayMs: 0, dur: 60, mode: 1, tbri: 0 };

  function handleNightlight() {
    if (now - lastTick < 100) return;
    lastTick = now;
    if (stalledTicks > 0) {
      stalledTicks--;
      return;
    }
    if (nl.active) {
      if (!nl.old) {
        nl.start = now;
        nl.delayMs = nl.dur * 60_000;
        nl.old = true;
      }
      if ((now - nl.start) / nl.delayMs >= 1) {
        nl.active = false;
        if (nl.mode === 0) wall.bri = nl.tbri;
        nl.old = false;
      }
    } else if (nl.old) {
      nl.old = false;
    }
  }

  /** The main loop runs every few milliseconds while time passes. */
  function advance(milliseconds: number) {
    const end = now + milliseconds;
    while (now < end) {
      now = Math.min(end, now + 5);
      handleNightlight();
    }
  }

  function apply(command: Record<string, unknown>) {
    if (typeof command.bri === 'number') wall.bri = command.bri;
    if (command.on === true && wall.bri === 0) wall.bri = wall.briLast;
    if (command.on === false && wall.bri > 0) {
      wall.briLast = wall.bri;
      wall.bri = 0;
    }
    const night = command.nl as Record<string, unknown> | undefined;
    if (night) {
      if (typeof night.on === 'boolean') nl.active = night.on;
      if (typeof night.dur === 'number') nl.dur = night.dur;
      if (typeof night.mode === 'number') nl.mode = night.mode;
      if (typeof night.tbri === 'number') nl.tbri = night.tbri;
    }
    // stateUpdated(): reaching the target brightness ends the nightlight, except
    // for a request with `udpn.nn` (CALL_MODE_NO_NOTIFY), which skips that check.
    const noNotify = (command.udpn as Record<string, unknown> | undefined)?.nn === true;
    if (!noNotify && wall.bri === nl.tbri && nl.mode !== 3) nl.active = false;
    if (wall.bri > 0) wall.briLast = wall.bri;
  }

  function state() {
    return {
      on: wall.bri > 0,
      bri: wall.bri,
      nl: {
        on: nl.active,
        dur: nl.dur,
        mode: nl.mode,
        tbri: nl.tbri,
        rem: nl.active ? Math.trunc((nl.delayMs - (now - nl.start)) / 1000) : -1,
      },
      seg: wall.segments.map((id) => ({ id })),
    };
  }

  const fetchController = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // A request takes a few milliseconds, but the nightlight handler never runs inside it.
    now += 3;
    if (url.endsWith('/json/info'))
      return new Response(JSON.stringify({ name: 'Wall', ver: '16.0.1', leds: { count: info.ledCount } }));
    if (typeof init?.body === 'string') {
      apply(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ success: true }));
    }
    stateReads++;
    return new Response(JSON.stringify(state()));
  };
  let stateReads = 0;
  const sleeps: number[] = [];
  const autoOffNotSet = vi.fn();
  const driver = createWledDriver({
    fetch: fetchController as typeof fetch,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      advance(milliseconds);
    },
    onAutoOffNotSet: autoOffNotSet,
  });
  return {
    driver,
    advance,
    sleeps,
    autoOffNotSet,
    stateReads: () => stateReads,
    countdownRunning: () => nl.active,
    /** Configure a longer strip in WLED, as its settings page would. */
    setLedCount: (count: number) => {
      info.ledCount = count;
    },
    lit: () => wall.bri > 0,
    /** Skip the handler's next ticks, as a busy main loop would. */
    stall: (ticks: number) => {
      stalledTicks = ticks;
    },
    switchOff: () => apply({ on: false }),
  };
}

const MINUTE = 60_000;

describe('WLED auto-off countdown', () => {
  it('restarts a running countdown when a climb is lit near its end, so the wall stays on', async () => {
    const wall = firmware();
    const session = createLedPreviewSession(wall.driver, 'restart.local', { autoOffMinutes: 1 });
    await session.show([4]);
    wall.advance(59_000);
    expect(wall.lit()).toBe(true);
    await session.show([5]);
    wall.advance(2_000);
    expect(wall.lit()).toBe(true);
    // A full minute after the second lighting, it goes dark.
    wall.advance(MINUTE);
    expect(wall.lit()).toBe(false);
    await session.close();
  });

  it('restarts the countdown when the whole wall is lit again', async () => {
    const wall = firmware();
    await wall.driver.lightAll('light-all.local', undefined, { autoOffMinutes: 1 });
    wall.advance(59_000);
    await wall.driver.lightAll('light-all.local', undefined, { autoOffMinutes: 1 });
    wall.advance(2_000);
    expect(wall.lit()).toBe(true);
    wall.advance(MINUTE);
    expect(wall.lit()).toBe(false);
  });

  it('keeps a countdown started in the last minute, so quick taps cost one state read', async () => {
    const wall = firmware();
    const preview = wall.driver.createPreview('quick.local', { autoOffMinutes: 15 });
    await preview.show([4]);
    const restarts = wall.sleeps.length;
    wall.advance(20_000);
    const reads = wall.stateReads();
    await preview.show([5]);
    expect(wall.sleeps).toHaveLength(restarts);
    // One GET of the state serves the off check and the countdown.
    expect(wall.stateReads() - reads).toBe(1);
    // Once the countdown is older than a minute, the next lighting restarts it.
    wall.advance(MINUTE);
    await preview.show([6]);
    expect(wall.sleeps.length).toBeGreaterThan(restarts);
    wall.advance(15 * MINUTE - 1_000);
    expect(wall.lit()).toBe(true);
  });

  it('tries again when a busy controller had not seen the countdown off yet', async () => {
    const wall = firmware();
    const preview = wall.driver.createPreview('busy.local', { autoOffMinutes: 1 });
    await preview.show([4]);
    wall.advance(50_000);
    // The handler misses the tick that should forget the old countdown.
    wall.stall(4);
    await preview.show([5]);
    wall.advance(30_000);
    expect(wall.lit()).toBe(true);
    wall.advance(MINUTE);
    expect(wall.lit()).toBe(false);
  });

  it('wakes the wall again after the auto-off switched it off', async () => {
    const wall = firmware();
    const preview = wall.driver.createPreview('woken.local', { autoOffMinutes: 1, brightness: 90 });
    await preview.show([4]);
    wall.advance(2 * MINUTE);
    expect(wall.lit()).toBe(false);
    await preview.show([5]);
    expect(wall.lit()).toBe(true);
    wall.advance(MINUTE - 1_000);
    expect(wall.lit()).toBe(true);
  });

  it('keeps the climb lit when the countdown cannot be armed, and says auto-off was not set', async () => {
    const wall = firmware();
    // A controller too busy to run its nightlight handler at all: `nl.rem` never confirms.
    wall.stall(Number.POSITIVE_INFINITY);
    const session = createLedPreviewSession(wall.driver, 'unarmed.local', { autoOffMinutes: 1 });
    await expect(session.show([4])).resolves.toBe(true);
    expect(wall.lit()).toBe(true);
    expect(wall.autoOffNotSet).toHaveBeenCalledOnce();
    await expect(wall.driver.lightAll('unarmed.local', undefined, { autoOffMinutes: 1 })).resolves.toBeUndefined();
    expect(wall.lit()).toBe(true);
    expect(wall.autoOffNotSet).toHaveBeenCalledTimes(2);
    await session.detach();
  });

  it('lights an LED the strip gained while the wall was off, instead of refusing it', async () => {
    const wall = firmware({ ledCount: 100 });
    const preview = wall.driver.createPreview('grown.local');
    await preview.show([4]);
    wall.switchOff();
    wall.setLedCount(300);
    await expect(preview.show([250])).resolves.toBeUndefined();
    expect(wall.lit()).toBe(true);
  });

  it('still restarts the countdown after Turn LEDs off left it running, as WLED 0.15 does', async () => {
    const wall = firmware();
    const preview = wall.driver.createPreview('switched.local', { autoOffMinutes: 1 });
    await preview.show([4]);
    wall.advance(30_000);
    await preview.turnOff();
    // `udpn.nn` skips the firmware's end-of-nightlight check: the countdown runs on.
    expect(wall.countdownRunning()).toBe(true);
    wall.advance(20_000);
    await preview.show([5]);
    wall.advance(MINUTE - 2_000);
    expect(wall.lit()).toBe(true);
    wall.advance(3_000);
    expect(wall.lit()).toBe(false);
  });

  it('cancels a running countdown when auto-off is turned off', async () => {
    const wall = firmware();
    await wall.driver.lightAll('never.local', undefined, { autoOffMinutes: 1 });
    await wall.driver.lightAll('never.local', undefined, { autoOffMinutes: 0 });
    wall.advance(10 * MINUTE);
    expect(wall.lit()).toBe(true);
  });
});
