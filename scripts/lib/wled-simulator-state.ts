// The state machine behind `vp run dev:wled-sim`: just enough of WLED's JSON API
// (https://kno.wled.ge/interfaces/json-api/) for the Boardsesh LED driver in
// packages/shared/led-controller to talk to it as if it were a real controller.
// Pure and clock-injected so it can be tested without a socket.

export type Rgb = [number, number, number];

export type WledSimulatorState = {
  name: string;
  ledCount: number;
  on: boolean;
  bri: number;
  /** One colour per physical LED, as segment 0 last painted it. */
  pixels: Rgb[];
  nightlight: { on: boolean; dur: number; startedAt: number | null };
};

const BLACK: Rgb = [0, 0, 0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createWledSimulatorState(ledCount: number, name = 'Boardsesh WLED simulator'): WledSimulatorState {
  if (!Number.isInteger(ledCount) || ledCount <= 0 || ledCount > 4096) throw new RangeError('LED count must be 1-4096');
  return {
    name,
    ledCount,
    on: false,
    bri: 128,
    pixels: Array.from({ length: ledCount }, () => [...BLACK] as Rgb),
    nightlight: { on: false, dur: 60, startedAt: null },
  };
}

/** A fixed, locally administered MAC (the 0x02 bit), so the app can find this fake by its hardware id. */
export const SIMULATOR_MAC = '02b0a2d5e5e1';

export function wledInfo(state: WledSimulatorState) {
  return {
    name: state.name,
    ver: '0.15.0-sim',
    brand: 'WLED',
    product: 'Simulator',
    mac: SIMULATOR_MAC,
    leds: { count: state.ledCount },
  };
}

export function wledState(state: WledSimulatorState, now: number) {
  return {
    on: state.on,
    bri: state.bri,
    nl: { on: state.nightlight.on, dur: state.nightlight.dur, rem: nightlightRemaining(state, now) },
    seg: [{ id: 0, start: 0, stop: state.ledCount, on: true }],
  };
}

/** Seconds left on the auto-off timer, or -1 when it is not running (WLED's convention). */
export function nightlightRemaining(state: WledSimulatorState, now: number): number {
  const { on, dur, startedAt } = state.nightlight;
  if (!on || startedAt === null) return -1;
  return Math.max(0, Math.round(dur * 60 - (now - startedAt) / 1000));
}

/** "RRGGBB", "RRGGBBWW" or [r, g, b(, w)] — the white channel is ignored. */
export function parseColor(value: unknown): Rgb | null {
  if (typeof value === 'string' && /^[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(value)) {
    return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
  }
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((channel) => Number.isInteger(channel))) {
    return value.slice(0, 3).map((channel: number) => Math.max(0, Math.min(255, channel))) as Rgb;
  }
  return null;
}

/**
 * WLED's individual-LED array: `[index, colour]` sets one LED and
 * `[start, stop, colour]` sets the half-open range start..stop-1.
 */
export function applyIndividualColors(state: WledSimulatorState, entries: readonly unknown[]): void {
  let position = 0;
  while (position < entries.length) {
    const first = entries[position];
    const second = entries[position + 1];
    if (typeof first !== 'number') throw new Error(`Expected an LED index at position ${position}`);
    if (typeof second === 'number') {
      const color = parseColor(entries[position + 2]);
      if (!color) throw new Error(`Expected a colour at position ${position + 2}`);
      for (let index = Math.max(0, first); index < Math.min(second, state.ledCount); index++) {
        state.pixels[index] = [...color];
      }
      position += 3;
    } else {
      const color = parseColor(second);
      if (!color) throw new Error(`Expected a colour at position ${position + 1}`);
      if (first >= 0 && first < state.ledCount) state.pixels[first] = color;
      position += 2;
    }
  }
}

/** Apply one POST /json/state body. Returns what changed, for the console log. */
export function applyWledCommand(state: WledSimulatorState, command: unknown, now: number): string[] {
  if (!isRecord(command)) throw new Error('The state command must be a JSON object');
  const changes: string[] = [];
  if (typeof command.on === 'boolean' && command.on !== state.on) {
    state.on = command.on;
    changes.push(command.on ? 'switched on' : 'switched off');
  }
  if (typeof command.bri === 'number' && command.bri !== state.bri) {
    state.bri = Math.max(0, Math.min(255, Math.round(command.bri)));
    changes.push(`brightness ${state.bri}/255`);
  }
  if (isRecord(command.nl)) {
    const nightlight = command.nl;
    if (typeof nightlight.dur === 'number') state.nightlight.dur = Math.max(1, Math.min(255, nightlight.dur));
    if (typeof nightlight.on === 'boolean') {
      // Like WLED, only an off-to-on change starts the countdown.
      if (nightlight.on && !state.nightlight.on) {
        state.nightlight.startedAt = now;
        changes.push(`auto-off in ${state.nightlight.dur} min`);
      }
      if (!nightlight.on && state.nightlight.on) state.nightlight.startedAt = null;
      state.nightlight.on = nightlight.on;
    }
  }
  if (Array.isArray(command.seg)) {
    for (const segment of command.seg) {
      if (!isRecord(segment) || (segment.id ?? 0) !== 0) continue;
      if (Array.isArray(segment.col) && segment.col.length) {
        const color = parseColor(segment.col[0]);
        if (color) {
          state.pixels = state.pixels.map(() => [...color] as Rgb);
          changes.push(`all LEDs ${color.join(',')}`);
        }
      }
      if (Array.isArray(segment.i)) {
        applyIndividualColors(state, segment.i);
        changes.push('individual LEDs');
      }
    }
  }
  return changes;
}

/** Fire the auto-off timer if it has run out. Returns true when it just switched the wall off. */
export function tickNightlight(state: WledSimulatorState, now: number): boolean {
  if (!state.nightlight.on || nightlightRemaining(state, now) > 0) return false;
  // Instant mode with target brightness 0: the wall goes dark.
  state.nightlight = { ...state.nightlight, on: false, startedAt: null };
  state.on = false;
  return true;
}

export function litIndices(state: WledSimulatorState): number[] {
  if (!state.on || state.bri === 0) return [];
  return state.pixels.flatMap((color, index) => (color.some((channel) => channel > 0) ? [index] : []));
}

/** The strip as rows of coloured blocks (24-bit ANSI), with the index of each row's first LED. */
export function renderStrip(state: WledSimulatorState, perRow = 50, colour = true): string {
  const lit = new Set(litIndices(state));
  const rows: string[] = [];
  for (let start = 0; start < state.ledCount; start += perRow) {
    let row = `${String(start).padStart(4)} `;
    for (let index = start; index < Math.min(start + perRow, state.ledCount); index++) {
      if (!lit.has(index)) {
        row += colour ? '\u001b[90m·\u001b[0m' : '·';
        continue;
      }
      const [red, green, blue] = state.pixels[index];
      row += colour ? `\u001b[38;2;${red};${green};${blue}m█\u001b[0m` : '█';
    }
    rows.push(row);
  }
  return rows.join('\n');
}
