import { describe, expect, it } from 'vitest';
import { createLedPreviewSession } from '../packages/shared/led-controller/src/preview';
import { createWledDriver } from '../packages/shared/led-controller/src/wled';
import {
  applyIndividualColors,
  applyWledCommand,
  createWledSimulatorState,
  litIndices,
  nightlightRemaining,
  renderStrip,
  tickNightlight,
  wledInfo,
  wledState,
  type WledSimulatorState,
} from './lib/wled-simulator-state';

/** Route the real Boardsesh driver's HTTP calls into the simulator state. */
function simulatedFetch(state: WledSimulatorState, clock: { now: number }): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON body');
      applyWledCommand(state, JSON.parse(init.body), clock.now);
      return new Response(JSON.stringify({ success: true }));
    }
    return new Response(JSON.stringify(path === '/json/info' ? wledInfo(state) : wledState(state, clock.now)));
  };
}

describe('WLED simulator', () => {
  it('is accepted by the Boardsesh driver and shows exactly the LEDs a selection lights', async () => {
    const state = createWledSimulatorState(120);
    const clock = { now: 0 };
    const driver = createWledDriver({ fetch: simulatedFetch(state, clock) });
    expect(await driver.probe('http://sim.local:8080')).toEqual({
      name: 'Boardsesh WLED simulator',
      version: '0.15.0-sim',
      ledCount: 120,
    });
    const session = createLedPreviewSession(driver, 'http://sim.local:8080', { brightness: 200 });
    await session.show([3, 7], [{ index: 3, color: [255, 0, 0] }]);
    expect(state.on).toBe(true);
    expect(state.bri).toBe(200);
    expect(litIndices(state)).toEqual([3, 7]);
    expect(state.pixels[3]).toEqual([255, 0, 0]);
    expect(state.pixels[7]).toEqual([255, 255, 255]);
    await session.show([8]);
    expect(litIndices(state)).toEqual([8]);
    await session.stop();
    expect(litIndices(state)).toEqual([]);
    await session.close();
  });

  it('runs the auto-off timer the driver arms and restarts it on later selections', async () => {
    const state = createWledSimulatorState(50);
    const clock = { now: 0 };
    const driver = createWledDriver({ fetch: simulatedFetch(state, clock) });
    const session = createLedPreviewSession(driver, 'http://timer.local', { autoOffMinutes: 1 });
    await session.show([1]);
    expect(nightlightRemaining(state, clock.now)).toBe(60);
    clock.now = 50_000;
    await session.show([2]);
    // The later selection restarted the countdown.
    expect(nightlightRemaining(state, clock.now)).toBe(60);
    clock.now = 50_000 + 60_000;
    expect(tickNightlight(state, clock.now)).toBe(true);
    expect(litIndices(state)).toEqual([]);
    // The next selection wakes the wall again.
    await session.show([3]);
    expect(litIndices(state)).toEqual([3]);
    await session.close();
  });

  it('understands both single LEDs and ranges in the individual-colour array', () => {
    const state = createWledSimulatorState(10);
    state.on = true;
    applyIndividualColors(state, [0, 10, '00000000', 2, 'FF000000', 5, 8, [0, 0, 255]]);
    expect(litIndices(state)).toEqual([2, 5, 6, 7]);
    expect(state.pixels[2]).toEqual([255, 0, 0]);
    expect(state.pixels[6]).toEqual([0, 0, 255]);
    expect(() => applyIndividualColors(state, [1, 'nope'])).toThrow('colour');
  });

  it('draws the strip in rows with the first index of each row', () => {
    const state = createWledSimulatorState(12);
    state.on = true;
    applyIndividualColors(state, [1, 'FFFFFF', 11, 'FFFFFF']);
    expect(renderStrip(state, 6, false)).toBe('   0 ·█····\n   6 ·····█');
  });
});
