import type { BleDisconnectInfo } from './types';

// Human-meaningful bucket for an unsolicited BLE drop, derived from the raw
// platform codes in BleDisconnectInfo so PostHog queries don't need per-OS
// lookup tables. Buckets describe what the radio observed, not intent:
// - peer_terminated: the board closed the link. On last-connection-wins boards
//   this is the takeover signature (another phone grabbed the wall), but it's
//   also what a board power-off looks like — pair with a same-board connect
//   from another user to confirm a takeover.
// - link_timeout: supervision timeout — out of range, RF loss, or the board
//   lost power mid-link without a clean teardown.
// - app_recovery: we dropped the link ourselves (write-stall recovery, #3181).
// - bluetooth_off: the phone's Bluetooth radio left poweredOn.
// - write_failure: a write flushed out an already-dead link the adapter never
//   reported (frequently a takeover on shared boards, but unproven).
// - unknown: platform reported nothing, or a code we don't map.
export type BleDisconnectCategory =
  | 'peer_terminated'
  | 'link_timeout'
  | 'app_recovery'
  | 'bluetooth_off'
  | 'write_failure'
  | 'unknown';

// CoreBluetooth CBError.Code values (CBErrorDomain). Only the two codes whose
// meaning is unambiguous for a mid-session drop are mapped; everything else
// stays 'unknown' rather than guessing.
const CB_ERROR_CONNECTION_TIMEOUT = 6;
const CB_ERROR_PERIPHERAL_DISCONNECTED = 7;

// Android GATT status codes (BLE spec HCI error codes, ble-plx androidErrorCode).
const GATT_CONN_TIMEOUT = 8; // 0x08 connection timeout
const GATT_REMOTE_USER_TERMINATED = 19; // 0x13 remote device terminated the connection

// The Swift write-stall recovery paths tag app-driven drops with these markers
// (BoardBleManager.swift); bluetooth_unavailable is the central-state marker.
const APP_RECOVERY_CONTEXTS = new Set([
  'write_stall_recovery_failed',
  'write_stall_budget_exhausted',
  'write_stall_recovery_timeout',
  // The cancel's didDisconnect arrived so long after the stall that the
  // recovery was abandoned rather than reconnected — the phone was suspended
  // through the window no watchdog can bound (#4499). Kept distinct from
  // _timeout, which is the opposite failure (no didDisconnect at all while the
  // radio stayed on): same bucket, different signature to query on.
  'write_stall_recovery_stale',
]);

export function classifyBleDisconnect(info: BleDisconnectInfo | null | undefined): BleDisconnectCategory {
  if (!info) return 'unknown';

  if (info.source === 'write-failure') return 'write_failure';

  if (info.context) {
    if (APP_RECOVERY_CONTEXTS.has(info.context)) return 'app_recovery';
    if (info.context === 'bluetooth_unavailable') return 'bluetooth_off';
    return 'unknown';
  }

  // iOS: only trust the code when it's a CBError. The native adapter always
  // reports the NSError domain (CBATTErrorDomain codes overlap numerically and
  // mean different things), so a domain-less code is trusted only from ble-plx,
  // which pre-splits into iosErrorCode and never carries a domain.
  const iosCodeIsCbError =
    info.errorDomain === 'CBErrorDomain' || (info.errorDomain === undefined && info.source === 'ble-plx');
  if (info.iosErrorCode !== undefined && iosCodeIsCbError) {
    if (info.iosErrorCode === CB_ERROR_PERIPHERAL_DISCONNECTED) return 'peer_terminated';
    if (info.iosErrorCode === CB_ERROR_CONNECTION_TIMEOUT) return 'link_timeout';
  }

  if (info.androidErrorCode !== undefined) {
    if (info.androidErrorCode === GATT_REMOTE_USER_TERMINATED) return 'peer_terminated';
    if (info.androidErrorCode === GATT_CONN_TIMEOUT) return 'link_timeout';
  }

  return 'unknown';
}
