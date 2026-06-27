import type { BleFailureCategory, BleSendFailureReason } from '@boardsesh/ble-protocol';
import type { BleConnectionDiagnostics } from '../sentry';

// In-session ring buffer of BLE events, attached (opt-in) to a bug report so a
// triager can see which board, which failure mode, and which write path was
// chosen — instead of starting from "Bluetooth doesn't work" with no signal.
//
// Module-level singleton with no React: events originate deep in the low-level
// adapter and the connection hook and are read exactly once at submit time, so
// there's nothing to subscribe to. Mirrors the module-store shape used by
// `bluetooth-status-store.ts`. Lives for the app session only — "recent" here
// means "this run", which is the scope a user reporting a live BLE problem
// cares about.

const MAX_EVENTS = 40;
// Discord caps an embed field value at 1024 chars; we cap the whole report well
// under that × a couple of fields' worth so the DB row stays compact and the
// webhook never has to hard-truncate mid-line.
const MAX_REPORT_LENGTH = 1800;

type BleEventBase = {
  /** Epoch ms (`Date.now()`), used only for ordering + a HH:MM:SS stamp. */
  at: number;
};

export type BleDiagnosticsEvent =
  | (BleEventBase & {
      type: 'device_found';
      deviceId: string;
      name?: string;
      rssi: number;
    })
  | (BleEventBase & {
      type: 'connect_success';
      boardName: string;
      layoutId?: number;
      sizeId?: number;
      apiLevel?: number;
      deviceNamePresent: boolean;
      diagnostics?: BleConnectionDiagnostics | null;
    })
  | (BleEventBase & {
      type: 'connect_failure';
      boardName?: string;
      failureCategory: BleFailureCategory;
      message: string;
    })
  | (BleEventBase & {
      type: 'send_failure';
      boardName?: string;
      failureReason: BleSendFailureReason;
      message: string;
    })
  | (BleEventBase & {
      type: 'disconnect';
      boardName?: string;
      kind: 'stolen' | 'dropped';
    });

export type BleDiagnosticsEventInput = DistributiveOmit<BleDiagnosticsEvent, 'at'>;

// `Omit` collapses a union to its common keys; this preserves each member so
// callers pass a single discriminated event without an `at` they don't own.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

const events: BleDiagnosticsEvent[] = [];

/** Append an event, evicting the oldest once the buffer is full. */
export function recordBleEvent(event: BleDiagnosticsEventInput): void {
  events.push({ ...event, at: Date.now() } as BleDiagnosticsEvent);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Snapshot of the buffer in insertion order (oldest first). */
export function getBleDiagnosticsEvents(): readonly BleDiagnosticsEvent[] {
  return events.slice();
}

/** Drop everything — for tests and a deliberate reset only. */
export function clearBleDiagnosticsLog(): void {
  events.length = 0;
}

function formatClock(at: number): string {
  // `new Date(ms)` with an argument is deterministic from the stamp.
  return new Date(at).toISOString().slice(11, 19);
}

function formatDiagnostics(diagnostics: BleConnectionDiagnostics | null | undefined): string {
  if (!diagnostics) return '';
  const parts: string[] = [];
  if (diagnostics.chosenWriteType) parts.push(`write=${diagnostics.chosenWriteType}`);
  if (diagnostics.supportsWriteWithoutResponse !== undefined) {
    parts.push(`supportsNoResp=${diagnostics.supportsWriteWithoutResponse}`);
  }
  if (diagnostics.characteristicProperties !== undefined)
    parts.push(`charProps=${diagnostics.characteristicProperties}`);
  if (diagnostics.maxWriteWithResponse !== undefined) parts.push(`maxResp=${diagnostics.maxWriteWithResponse}`);
  if (diagnostics.maxWriteWithoutResponse !== undefined) {
    parts.push(`maxNoResp=${diagnostics.maxWriteWithoutResponse}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function formatEvent(event: BleDiagnosticsEvent): string {
  const clock = formatClock(event.at);
  switch (event.type) {
    case 'connect_success': {
      const board = [event.boardName, event.layoutId != null ? `layout ${event.layoutId}` : null]
        .filter(Boolean)
        .join('/');
      const api = event.apiLevel != null ? ` api v${event.apiLevel}` : '';
      const named = event.deviceNamePresent ? '' : ' (no advertised name)';
      return `${clock} connect_success ${board}${api}${named}${formatDiagnostics(event.diagnostics)}`;
    }
    case 'connect_failure':
      return `${clock} connect_failure ${event.boardName ?? '?'} category=${event.failureCategory} — ${event.message}`;
    case 'send_failure':
      return `${clock} send_failure ${event.boardName ?? '?'} reason=${event.failureReason} — ${event.message}`;
    case 'disconnect':
      return `${clock} disconnect ${event.boardName ?? '?'} (${event.kind})`;
    case 'device_found':
      return '';
  }
}

/**
 * Render the session's BLE activity as a compact text block, or null when the
 * buffer is empty. Devices are deduped by id (latest name/rssi wins); the event
 * timeline lists newest first and excludes device_found (covered by the device
 * list). Capped to MAX_REPORT_LENGTH.
 */
export function buildBleDiagnosticsReport(): string | null {
  if (events.length === 0) return null;

  const latestById = new Map<string, Extract<BleDiagnosticsEvent, { type: 'device_found' }>>();
  for (const event of events) {
    if (event.type === 'device_found') latestById.set(event.deviceId, event);
  }

  const lines: string[] = [];
  lines.push('BLE diagnostics (this app session)');
  // iOS native scans enumerate peripherals in Swift, so the device list can be
  // sparse there; connection events below are captured on every platform.

  if (latestById.size > 0) {
    lines.push(`Devices found (${latestById.size}):`);
    for (const device of latestById.values()) {
      lines.push(`- ${device.name ?? '(no name)'} | id=${device.deviceId} | rssi ${device.rssi}`);
    }
  } else {
    lines.push('Devices found: none recorded');
  }

  const timeline = events
    .filter((event) => event.type !== 'device_found')
    .reverse()
    .map(formatEvent)
    .filter((line) => line.length > 0);

  if (timeline.length > 0) {
    lines.push('Recent events (newest first):');
    for (const line of timeline) lines.push(`- ${line}`);
  } else {
    lines.push('Recent connection events: none recorded');
  }

  const report = lines.join('\n');
  return report.length > MAX_REPORT_LENGTH ? `${report.slice(0, MAX_REPORT_LENGTH - 1)}…` : report;
}
