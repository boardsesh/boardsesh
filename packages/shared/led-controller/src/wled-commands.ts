import {
  LedControllerError,
  resolveLedLightingOptions,
  type LedControllerDriver,
  type LedControllerInfo,
} from './types';
import { snapshotLedPixels } from './led-pixels';

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function readInfo(payload: unknown): LedControllerInfo {
  // WLED manufacturers can customize the brand (for example, Athom).
  // Validate the API fields we use rather than a specific manufacturer name.
  if (
    !isRecord(payload) ||
    typeof payload.name !== 'string' ||
    !payload.name.trim() ||
    typeof payload.ver !== 'string' ||
    !payload.ver.trim() ||
    (payload.brand !== undefined && typeof payload.brand !== 'string') ||
    !isRecord(payload.leds) ||
    typeof payload.leds.count !== 'number' ||
    !Number.isSafeInteger(payload.leds.count) ||
    payload.leds.count <= 0
  ) {
    throw new LedControllerError('not-wled');
  }
  return { name: payload.name, version: payload.ver, ledCount: payload.leds.count };
}

function segmentIds(payload: unknown): number[] {
  if (!isRecord(payload) || !Array.isArray(payload.seg)) {
    throw new LedControllerError('not-wled');
  }
  const ids = new Set([0]);
  for (const segment of payload.seg) {
    if (
      !isRecord(segment) ||
      typeof segment.id !== 'number' ||
      !Number.isInteger(segment.id) ||
      segment.id < 0 ||
      segment.id > 255
    ) {
      throw new LedControllerError('not-wled');
    }
    ids.add(segment.id);
  }
  return [...ids];
}

function isSwitchedOff(state: unknown): boolean {
  return isRecord(state) && (state.on === false || state.bri === 0);
}

/**
 * Auto-off uses WLED's nightlight in instant mode (0): after `dur` minutes it sets
 * the brightness to `tbri` 0, so the wall goes dark even when the phone is asleep
 * or gone.
 *
 * Restarting a running countdown takes two steps, because the JSON request only
 * sets `nightlightActive`. WLED's `handleNightlight`, which runs at most every
 * 100 ms on its own, starts the countdown when it first sees the flag on, and only
 * forgets a running one when it sees the flag off. A `dur` change alone does
 * nothing either: the length is read when the countdown starts. So: switch it
 * off, let a tick pass, switch it on, let a tick pass, and confirm with `nl.rem`
 * (seconds remaining) in the state. WLED v0.15.0 and 16.0.1 behave the same:
 * json.cpp `deserializeState`, led.cpp `handleNightlight`.
 */
const NIGHTLIGHT_TICK_MS = 300;
/**
 * A countdown restarted this recently (at most a tenth of its length) counts as
 * current, so quick taps do not each restart it.
 */
const NIGHTLIGHT_FRESH_SECONDS = 60;
/** Right after arming, the time left is the full length less the request time. */
const NIGHTLIGHT_ARMED_SLACK_SECONDS = 5;
const NIGHTLIGHT_ATTEMPTS = 3;

type Nightlight = { on: boolean; dur?: number; mode?: number; tbri?: number; rem?: number };

function readNightlight(state: unknown): Nightlight | null {
  if (!isRecord(state) || !isRecord(state.nl) || typeof state.nl.on !== 'boolean') return null;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const { on, dur, mode, tbri, rem } = state.nl;
  return { on, dur: number(dur), mode: number(mode), tbri: number(tbri), rem: number(rem) };
}

function autoOffCommand(minutes: number) {
  return { on: true, dur: minutes, mode: 0, tbri: 0 };
}

function countdownIsCurrent(
  nightlight: Nightlight,
  minutes: number,
  slackSeconds = Math.min(NIGHTLIGHT_FRESH_SECONDS, minutes * 6),
): boolean {
  return (
    nightlight.on &&
    nightlight.dur === minutes &&
    nightlight.mode === 0 &&
    nightlight.tbri === 0 &&
    nightlight.rem !== undefined &&
    nightlight.rem >= minutes * 60 - slackSeconds
  );
}

export type WledRequest = (
  target: string,
  path: 'info' | 'state',
  signal?: AbortSignal,
  command?: Record<string, unknown>,
) => Promise<unknown>;

export interface WledCommandOptions {
  /**
   * Whether the transport can set the nightlight's `dur`, `mode` and `tbri`, which
   * auto-off needs. The Bluetooth usermod only accepts `nl.on` for now, so there
   * the brightness applies and auto-off does not.
   */
  autoOff?: boolean;
  /** Waits for WLED's nightlight tick; tests replace it. */
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Told when the colours are on the wall but the countdown could not be armed.
   * The climb stays lit: a missed auto-off is better than a dark wall. Logs by default.
   */
  onAutoOffNotSet?: (error: unknown) => void;
}

/** All WLED lighting semantics live here, independently of HTTP or BLE. */
export function createWledCommandDriver(request: WledRequest, options: WledCommandOptions = {}): LedControllerDriver {
  const supportsAutoOff = options.autoOff ?? true;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const onAutoOffNotSet =
    options.onAutoOffNotSet ??
    ((error: unknown) => console.warn('[WLED] Auto-off not set; the wall stays lit.', error));
  async function send(url: string, command: Record<string, unknown>, signal?: AbortSignal) {
    const response = await request(url, 'state', signal, command);
    if (!isRecord(response) || response.success !== true) {
      throw new LedControllerError('command-failed');
    }
  }

  /**
   * An unreadable state is no reason to blank a lit wall (it reads as on); the write
   * that follows says if the controller is gone.
   */
  async function readState(url: string): Promise<unknown> {
    try {
      return await request(url, 'state');
    } catch {
      return undefined;
    }
  }

  async function waitForNightlightTick(signal?: AbortSignal) {
    await sleep(NIGHTLIGHT_TICK_MS);
    if (signal?.aborted) throw new LedControllerError('cancelled');
  }

  async function readCountdown(url: string, signal?: AbortSignal): Promise<Nightlight | null> {
    try {
      return readNightlight(await request(url, 'state', signal));
    } catch (error) {
      if (error instanceof LedControllerError && error.code === 'cancelled') throw error;
      return null;
    }
  }

  /**
   * Before lighting with auto-off: a countdown restarted in the last minute stays.
   * Any other running one is switched off and given a tick, so that WLED forgets
   * it and the next `nl.on` starts a new one. It can no longer run out mid-write.
   * Returns whether the countdown must be armed after the write.
   */
  async function stopStaleCountdown(url: string, minutes: number, signal?: AbortSignal, state?: unknown) {
    const nightlight = state === undefined ? await readCountdown(url, signal) : readNightlight(state);
    if (nightlight && countdownIsCurrent(nightlight, minutes)) return false;
    if (!nightlight || nightlight.on) {
      await send(url, { nl: { on: false }, udpn: { nn: true } }, signal);
      await waitForNightlightTick(signal);
    }
    return true;
  }

  /**
   * Arm the countdown after the colours are on the wall. A failure here is soft: the
   * operation succeeds with the climb lit, so the preview does not switch the wall
   * off over a convenience. Only a cancellation still fails it.
   */
  async function armCountdownAfterLighting(url: string, minutes: number, signal?: AbortSignal) {
    try {
      await armCountdown(url, minutes, signal);
    } catch (error) {
      if (error instanceof LedControllerError && error.code === 'cancelled') throw error;
      onAutoOffNotSet(error);
    }
  }

  /** Arm the countdown and confirm from the state that WLED started a new one. */
  async function armCountdown(url: string, minutes: number, signal?: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      await send(url, { nl: autoOffCommand(minutes), udpn: { nn: true } }, signal);
      await waitForNightlightTick(signal);
      const nightlight = await readCountdown(url, signal);
      // Firmware that does not report the time left cannot be checked.
      if (nightlight?.rem === undefined || countdownIsCurrent(nightlight, minutes, NIGHTLIGHT_ARMED_SLACK_SECONDS))
        return;
      if (attempt >= NIGHTLIGHT_ATTEMPTS) throw new LedControllerError('command-failed');
      // The handler had not seen the old countdown off yet, so it kept running.
      await send(url, { nl: { on: false }, udpn: { nn: true } }, signal);
      await waitForNightlightTick(signal);
    }
  }

  const driver: LedControllerDriver = {
    async probe(url, signal) {
      return readInfo(await request(url, 'info', signal));
    },
    async lightAll(url, signal, lighting) {
      const { brightness, autoOffMinutes } = resolveLedLightingOptions(lighting);
      const minutes = supportsAutoOff ? autoOffMinutes : 0;
      // Re-read the count and segments: a previous successful probe can be stale.
      const info = readInfo(await request(url, 'info', signal));
      const state = await request(url, 'state', signal);
      const ids = segmentIds(state);
      const arm = minutes > 0 && (await stopStaleCountdown(url, minutes, signal, state));
      // Like CRUX's 1D output, cover the full cable with segment 0. Existing
      // overlapping segments receive the same solid colour rather than being
      // deleted. This changes live state only; no presets/configuration are saved.
      await send(
        url,
        {
          on: true,
          bri: brightness,
          tt: 0,
          live: false,
          lor: 1,
          // With auto-off the countdown is handled around this write; without, any is cancelled.
          ...(minutes > 0 ? {} : { nl: { on: false } }),
          udpn: { nn: true },
          seg: ids.map((id) => ({
            id,
            ...(id === 0 ? { start: 0, stop: info.ledCount } : {}),
            on: true,
            bri: 255,
            fx: 0,
            pal: 0,
            grp: 1,
            spc: 0,
            of: 0,
            rev: false,
            mi: false,
            frz: false,
            col: [[255, 255, 255, 255]],
          })),
        },
        signal,
      );
      if (arm) await armCountdownAfterLighting(url, minutes, signal);
    },
    async turnOff(url, signal) {
      await send(url, { on: false, tt: 0, live: false, udpn: { nn: true } }, signal);
    },
    createPreview(url, lighting) {
      const { brightness, autoOffMinutes } = resolveLedLightingOptions(lighting);
      const minutes = supportsAutoOff ? autoOffMinutes : 0;
      let count: number | null = null;
      let previous: number[] = [];
      let mayBeLit = false;
      return {
        async show(indices, pixels) {
          const pixelSnapshot = snapshotLedPixels(indices, pixels);
          const next = [...new Set(indices)];
          const pixelColors = new Map<number, string>();
          for (const pixel of pixelSnapshot ?? []) {
            // The fourth channel stays off so WLED RGBW strips retain route hues.
            pixelColors.set(
              pixel.index,
              pixel.color
                .map((channel) => channel.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase() + '00',
            );
          }
          const checkIndices = (ledCount: number) => {
            if (next.some((index) => index >= ledCount)) throw new LedControllerError('invalid-indices');
            return ledCount;
          };
          // One state read per tap serves the off check, the countdown and the segments.
          // It is skipped only when nothing needs it: no auto-off and a fresh wake.
          const state = count !== null || minutes > 0 ? await readState(url) : undefined;
          // The WLED app, a button, Turn LEDs off or the auto-off may have switched it
          // off since the last write. Individual colours alone would be acknowledged
          // and stay dark, so start again from the full wake, with the LED count read
          // again before the indices are checked: it may have grown meanwhile.
          if (count !== null && isSwitchedOff(state)) {
            count = null;
            previous = [];
          }
          const ledCount = checkIndices(count ?? (await driver.probe(url)).ledCount);
          const arm = minutes > 0 && (await stopStaleCountdown(url, minutes, undefined, state ?? null));
          if (count === null) {
            const ids = segmentIds(state ?? (await request(url, 'state')));
            // Individual indices are segment-relative. Reset segment 0 to the
            // whole cable and suspend overlapping segments without deleting them.
            // WLED requires waking/brightness BEFORE an individual-colour request.
            mayBeLit = true;
            await send(url, {
              on: true,
              bri: brightness,
              tt: 0,
              live: false,
              lor: 1,
              ...(minutes > 0 ? {} : { nl: { on: false } }),
              udpn: { nn: true },
              seg: ids.map((id) =>
                id === 0
                  ? {
                      id,
                      start: 0,
                      stop: ledCount,
                      on: true,
                      bri: 255,
                      fx: 0,
                      pal: 0,
                      grp: 1,
                      spc: 0,
                      of: 0,
                      rev: false,
                      mi: false,
                      frz: false,
                      col: [[0, 0, 0, 0]],
                    }
                  : { id, on: false },
              ),
            });
          }
          const colors: (number | string)[] = count === null ? [0, ledCount, '00000000'] : [];
          for (const index of previous) colors.push(index, '00000000');
          for (const index of next) colors.push(index, pixelColors.get(index) ?? 'FFFFFFFF');
          // Keep requests below WLED's JSON buffer even for a large selection.
          for (let offset = 0; offset < colors.length; offset += offset === 0 && count === null ? 259 : 256) {
            const size = offset === 0 && count === null ? 259 : 256;
            await send(url, { tt: 0, udpn: { nn: true }, seg: [{ id: 0, i: colors.slice(offset, offset + size) }] });
          }
          if (arm) await armCountdownAfterLighting(url, minutes);
          count = ledCount;
          previous = next;
        },
        async lightAll() {
          count = null;
          previous = [];
          mayBeLit = true;
          await driver.lightAll(url, undefined, lighting);
        },
        async turnOff() {
          if (!mayBeLit) return;
          count = null;
          previous = [];
          await driver.turnOff(url);
          mayBeLit = false;
        },
      };
    },
  };
  return driver;
}
