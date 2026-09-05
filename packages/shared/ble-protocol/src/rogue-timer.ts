// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Rogue Fitness BLE timer protocol (Home Timer 2.0 / Echo Gym Timer 2.0).
// Pure byte-building — no transport, platform-agnostic. Reverse-engineered from
// the Rogue Fitness Android app; full spec in ROGUE_TIMER_BLE_SPEC.md.
//
// The timer is an HM-10-class transparent-UART peripheral. You drive it
// fire-and-forget with 4-byte remote key-code frames — no ACK, no CRC, no
// length field, one frame per write. `ffe1` is the single bidirectional UART
// pipe; for driving the timer it is write-only (notifications are best-effort
// status echoes we don't need — spec §7/§8).

// GATT profile (spec §2). The advertised 16-bit service is 0xFFE0; the full
// 128-bit forms below are what react-native-ble-plx / Web Bluetooth match on.
export const ROGUE_TIMER_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const ROGUE_TIMER_CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
// The 16-bit form advertised in scan records; used as the scan service filter.
export const ROGUE_TIMER_ADVERTISED_SERVICE_UUID = 'FFE0';

// Fixed frame preamble: sync0, sync1, message-type. The 4th byte is the code.
const FRAME_SYNC_0 = 0x55;
const FRAME_SYNC_1 = 0xaa;
const FRAME_TYPE = 0x01;

// Complete remote button map (spec §6). The numeric value is the 4th frame byte.
// The full table is kept (not just the codes the stopwatch POC uses) so the
// future sessions/workout driver can compose interval, EMOM, countdown, and
// numpad-entry flows from the same source of truth.
export const RogueTimerCommand = {
  POWER: 0x00, // On/Off
  VOICE: 0x01,
  INT: 0x02, // Interval timer
  UP_DOWN: 0x03, // Toggle count direction
  STOPWATCH: 0x04, // Stopwatch mode
  BTS: 0x05,
  FGB: 0x06, // Fight Gone Bad preset
  TBT: 0x07, // Tabata preset
  CLOCK: 0x08,
  HOURS: 0x09, // Toggle 12/24-hour
  RESET: 0x0a, // Clears stopwatch to 0:00
  PLUS10: 0x0b, // +10s warm-up toggle
  OK: 0x0c, // OK / Select
  ARROW_UP: 0x0d,
  ARROW_DOWN: 0x0e,
  ARROW_RIGHT: 0x0f,
  ARROW_LEFT: 0x10,
  EXIT: 0x11, // Exit / Back
  SET: 0x12, // Open timer setup
  BTN0: 0x13, // Numpad 0
  BTN1: 0x14,
  BTN2: 0x15,
  BTN3: 0x16,
  BTN4: 0x17,
  BTN5: 0x18,
  BTN6: 0x19,
  BTN7: 0x1a,
  BTN8: 0x1b,
  BTN9: 0x1c, // Numpad 9
  VOLUME_UP: 0x1d,
  VOLUME_DOWN: 0x1e,
  WARMUP: 0x20, // Warm-Up countdown
  EMOM: 0x21, // EMOM preset
} as const;

export type RogueTimerCommandName = keyof typeof RogueTimerCommand;
export type RogueTimerCommandCode = (typeof RogueTimerCommand)[RogueTimerCommandName];

// Numpad code for a single digit 0-9 (spec §6: BTN0=0x13 … BTN9=0x1C), for
// composing setup-screen value entry (SET → digits → OK). Throws on non-digits
// so a bad caller fails loudly rather than pressing a wrong button.
export function rogueTimerNumpadCode(digit: number): RogueTimerCommandCode {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    throw new RangeError(`Rogue timer numpad digit out of range: ${digit}`);
  }
  return (RogueTimerCommand.BTN0 + digit) as RogueTimerCommandCode;
}

// The 4-byte on-the-wire frame for a single button press: `55 AA 01 <code>`.
export function buildRogueTimerFrame(code: RogueTimerCommandCode): Uint8Array {
  return new Uint8Array([FRAME_SYNC_0, FRAME_SYNC_1, FRAME_TYPE, code]);
}

// Discovery name match (spec §3): name or localName contains `rogue` or `echo`.
// NOTE: this identifies the Rogue/Echo *brand*, not a timer specifically — it is
// true for Echo cardio too (rower/bike/skier). Pair it with
// `detectRogueDeviceType(name) === 'timer'` to isolate drivable timers.
export function isRogueEchoDeviceName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes('rogue') || lower.includes('echo');
}

export type RogueDeviceType = 'timer' | 'rower' | 'bike' | 'skier' | 'unknown';

// Classify a Rogue peripheral from its advertised name (spec §3, substring,
// case-insensitive). Only `timer` is a device this protocol module drives; the
// console family (rower/bike/skier) uses a different, heavier protocol.
export function detectRogueDeviceType(name: string | null | undefined): RogueDeviceType {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (lower.includes('timer') || lower.includes('home tim') || lower.includes('gym tim')) return 'timer';
  if (lower.includes('console') || lower.includes('rower') || lower.includes('echo_rower')) return 'rower';
  if (lower.includes('bike') || lower.includes('echo_bike')) return 'bike';
  if (lower.includes('ski') || lower.includes('echo_skier')) return 'skier';
  return 'unknown';
}
