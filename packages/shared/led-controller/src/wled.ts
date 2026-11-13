import {
  LedControllerError,
  resolveLedLightingOptions,
  type LedControllerDriver,
  type LedControllerInfo,
  type LedLightingOptions,
} from './types';
import { normalizeLocalControllerUrl } from './url';
import { snapshotLedPixels } from './led-pixels';

export interface WledDriverOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

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
 * WLED's nightlight in "instant" mode (0) drops to brightness 0 after `dur`
 * minutes, so the controller turns the wall off by itself even when the phone
 * is asleep or gone. The timer starts when `nl.on` changes from false to true.
 */
function nightlight(autoOffMinutes: number) {
  return autoOffMinutes > 0 ? { on: true, dur: autoOffMinutes, mode: 0, tbri: 0 } : { on: false };
}

export function createWledDriver(options: WledDriverOptions = {}): LedControllerDriver {
  const fetchController = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid WLED timeout');

  async function request(
    url: string,
    path: 'info' | 'state',
    signal?: AbortSignal,
    command?: Record<string, unknown>,
  ): Promise<unknown> {
    const baseUrl = normalizeLocalControllerUrl(url);
    if (signal?.aborted) throw new LedControllerError('cancelled');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onCancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onCancel = () => {
        reject(new LedControllerError('cancelled'));
        controller.abort();
      };
      signal?.addEventListener('abort', onCancel, { once: true });
      timeout = setTimeout(() => {
        reject(new LedControllerError('timeout'));
        controller.abort();
      }, timeoutMs);
    });
    const exchange = async (): Promise<unknown> => {
      try {
        const response = await fetchController(`${baseUrl}/json/${path}`, {
          method: command ? 'POST' : 'GET',
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          headers: command
            ? { Accept: 'application/json', 'Content-Type': 'application/json' }
            : { Accept: 'application/json' },
          ...(command ? { body: JSON.stringify(command) } : {}),
        });
        if (!response.ok) throw new LedControllerError(command ? 'command-failed' : 'unavailable');
        try {
          return await response.json();
        } catch {
          throw new LedControllerError(command ? 'command-failed' : 'not-wled');
        }
      } catch (error) {
        if (error instanceof LedControllerError) throw error;
        throw new LedControllerError('unavailable');
      }
    };
    try {
      return await Promise.race([exchange(), interrupted]);
    } finally {
      clearTimeout(timeout);
      if (onCancel) signal?.removeEventListener('abort', onCancel);
    }
  }

  async function send(url: string, command: Record<string, unknown>, signal?: AbortSignal) {
    const response = await request(url, 'state', signal, command);
    if (!isRecord(response) || response.success !== true) {
      throw new LedControllerError('command-failed');
    }
  }

  /** An unreadable state is no reason to blank a lit wall; the write that follows says if the controller is gone. */
  async function switchedOffSinceLastWrite(url: string) {
    try {
      return isSwitchedOff(await request(url, 'state'));
    } catch {
      return false;
    }
  }

  const driver: LedControllerDriver = {
    async probe(url, signal) {
      return readInfo(await request(url, 'info', signal));
    },
    async lightAll(url, signal, lighting) {
      const { brightness, autoOffMinutes } = resolveLedLightingOptions(lighting);
      // Re-read the count and segments: a previous successful probe can be stale.
      const info = readInfo(await request(url, 'info', signal));
      const ids = segmentIds(await request(url, 'state', signal));
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
          nl: nightlight(autoOffMinutes),
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
    },
    async turnOff(url, signal) {
      await send(url, { on: false, tt: 0, live: false, udpn: { nn: true } }, signal);
    },
    createPreview(url, lighting) {
      const { brightness, autoOffMinutes } = resolveLedLightingOptions(lighting);
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
          // The WLED app, a button or Turn LEDs off may have switched it off since
          // the last write. Individual colours alone would be acknowledged and
          // stay dark, so start again from the full wake.
          if (count !== null && (await switchedOffSinceLastWrite(url))) {
            count = null;
            previous = [];
          }
          const ledCount = count ?? (await driver.probe(url)).ledCount;
          if (next.some((index) => index >= ledCount)) throw new LedControllerError('invalid-indices');
          if (count === null) {
            const ids = segmentIds(await request(url, 'state'));
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
              nl: { on: false },
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
          } else if (autoOffMinutes > 0) {
            // The auto-off may already have switched the wall off since the last
            // write. Wake it again, and stop the old timer so the next colour
            // write restarts it: the countdown runs from the latest activity.
            await send(url, { on: true, bri: brightness, tt: 0, nl: { on: false }, udpn: { nn: true } });
          }
          const colors: (number | string)[] = count === null ? [0, ledCount, '00000000'] : [];
          for (const index of previous) colors.push(index, '00000000');
          for (const index of next) colors.push(index, pixelColors.get(index) ?? 'FFFFFFFF');
          // Keep requests below WLED's JSON buffer even for a large selection.
          for (let offset = 0; offset < colors.length; offset += offset === 0 && count === null ? 259 : 256) {
            const size = offset === 0 && count === null ? 259 : 256;
            await send(url, {
              tt: 0,
              udpn: { nn: true },
              ...(offset === 0 && autoOffMinutes > 0 ? { nl: nightlight(autoOffMinutes) } : {}),
              seg: [{ id: 0, i: colors.slice(offset, offset + size) }],
            });
          }
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

export const wledDriver = createWledDriver();
