/**
 * Classifies a thrown BLE error into an actionable category so the connect
 * flow can show the user a message that explains what went wrong (instead of
 * failing silently). Pure TS — no React, no DOM — so it's unit-testable and
 * usable from any adapter path (web / Capacitor / native iOS).
 *
 * The consumer maps the category to user-facing copy with a literal-key switch
 * (the i18n linter forbids `t(variable)`). `'user_cancelled'` shows nothing:
 * dismissing the device picker isn't a failure, so we stay silent.
 */
export type BleFailureCategory =
  | 'unavailable' // Bluetooth off / unsupported / unauthorized
  | 'user_cancelled' // user dismissed the picker — no message
  | 'board_not_found' // scan found nothing / target serial never appeared
  | 'connect_failed' // GATT connect failed or timed out
  | 'service_missing' // connected but UART service/characteristic absent
  | 'unknown';

/**
 * Reason a *send* to the board failed, tracked on `Climb Sent to Board Failure`.
 * The classifier below covers the thrown-during-write cases; callers also set
 * the explicit, pre-write reasons (`incompatible_climb`, `missing_led_placements`,
 * `missing_mirror_data`) directly at their return-false sites. Kept as one union
 * so web and mobile emit byte-identical strings and the reliability metric is
 * comparable across platforms.
 */
export type BleSendFailureReason =
  | 'disconnected' // write threw on a dead GATT link (board dropped / stolen)
  | 'incompatible_climb' // every placement skipped — climb is for another board
  | 'missing_led_placements' // LED placement map empty for this board config
  | 'missing_mirror_data' // mirroring requested but holdsData absent (pre-write)
  | 'missing_mirror_mapping' // a hold had no mirrored id while building the mirror
  | 'write_timeout' // native write-resume timeout; the native layer is auto-recovering it (#3181)
  | 'write_recovery_failed' // a write_timeout the native reconnect recovery could not fix — gave up (#3181)
  | 'write_failed' // any other thrown write failure on a live link
  | 'unknown' // defensive fallback: a `false` send left no reason set (unreachable in practice)
  | `dom_${string}`; // a DOMException name we don't otherwise classify

function errorName(error: unknown): string | undefined {
  // Guard DOMException for non-DOM environments (native iOS adapter does the
  // same) — `instanceof DOMException` would throw a ReferenceError otherwise.
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Classify a thrown error from a connect attempt. `pairingStage` is the stage
 * tag the hook tracks; we use `gatt_connect` as a fallback signal for
 * `connect_failed` when the message itself isn't conclusive. Note: the
 * scan-timeout path is tagged `gatt_connect` (the stage is advanced before
 * `requestAndConnect` runs), so classification must lean on the message for
 * `board_not_found` rather than the stage.
 */
export function classifyBleFailure(error: unknown, pairingStage?: string): BleFailureCategory {
  const name = errorName(error);
  const message = errorMessage(error);

  // User dismissed the picker. Match only explicit user-cancel signals — a bare
  // "cancel" would also swallow real failures like CoreBluetooth's
  // "operation cancelled" / "Connection cancelled by peer", silently showing
  // the user nothing. NotFoundError is the Web Bluetooth chooser-dismissed name.
  if (name === 'NotFoundError' || /user cancell?ed|Device selection cancelled/i.test(message)) {
    return 'user_cancelled';
  }

  // Connected at the GATT layer but the board didn't expose the UART service or
  // its write characteristic. Checked before board_not_found so a "...not found"
  // UART message isn't swallowed by the board-not-found patterns below. Covers
  // the web adapter's "Failed to get UART characteristic" and the Swift
  // "UART service was not found" / "Write characteristic was not found".
  if (
    /UART (service|characteristic)|write characteristic|characteristic.*not found|service.*not found/i.test(message)
  ) {
    return 'service_missing';
  }

  // Scan found nothing / the target board's serial never showed up. Anchored to
  // device/board so a future unrelated "X not found" doesn't land here by accident.
  // "No boards found" is the native scan-timeout message (word order is "boards
  // found", which "board.*not found" wouldn't match).
  if (
    /Target board not found during scan|No boards? found|device.*not found|board.*not found|deviceNotFound/i.test(
      message,
    )
  ) {
    return 'board_not_found';
  }

  // GATT-level connect failure or timeout. The headline path for "the board is
  // there but we couldn't establish the link".
  if (
    /GATT|gatt|timed out|timeout|failed to connect|connection failed/i.test(message) ||
    pairingStage === 'gatt_connect'
  ) {
    return 'connect_failed';
  }

  if (/not available|unavailable|powered ?off|poweredOff/i.test(message)) {
    return 'unavailable';
  }

  return 'unknown';
}

/**
 * True when an error thrown from a *write* (not a connect attempt) means the
 * GATT link is gone — the board dropped, another device grabbed it (these
 * boards are last-connection-wins), or the OS tore the connection down. The
 * write path otherwise swallows failures and leaves `isConnected` stuck true,
 * so the lightbulb keeps showing "connected" on a dead link. Callers use this
 * to mark the connection lost and offer a deliberate reconnect.
 *
 * Deliberately tight to avoid false-positive teardown: `AbortError` (the
 * unmount-mid-write path) and ordinary value/validation failures must NOT
 * count — only transport-level disconnect signatures do.
 */
export function isDisconnectionError(error: unknown): boolean {
  const name = errorName(error);
  // Unmount-mid-write — the AutoSender aborts its in-flight write on unmount.
  // Not a real disconnect; the caller handles it separately.
  if (name === 'AbortError') return false;
  const message = errorMessage(error);
  // Web Bluetooth surfaces a dead GATT link as NetworkError ("GATT Server is
  // disconnected..."). InvalidStateError can mean the same once the GATT handle
  // is torn down, but it also fires for unrelated reasons (closed
  // IDBTransaction, double-read ReadableStream), so require a GATT mention.
  if (name === 'NetworkError') return true;
  if (name === 'InvalidStateError') return /gatt/i.test(message);
  // Capacitor / native iOS adapters throw plain Errors: "Not connected",
  // "Device disconnected during write", and CoreBluetooth/Android plugin
  // rejections that name a disconnected / unreachable peripheral.
  return /GATT (server|operation).*(disconnect|not connected)|not connected|disconnected|peripheral.*(disconnect|unreachable)/i.test(
    message,
  );
}

/**
 * True when a write error is the native iOS BLE manager's write-resume timeout
 * ("BLE write timed out waiting for the board to accept data") — a marginal link
 * that stayed connected but stopped accepting write-without-response data. As of
 * #3181 the native layer auto-recovers this by cycling the connection, so it's a
 * transient, self-healing condition rather than a hard failure: callers report it
 * at `warning` (not `error`) so it doesn't drown real send failures.
 *
 * CONTRACT: matched against `BoardBleError.writeTimedOut.errorDescription` in
 * `packages/mobile/modules/live-activity/ios/BoardBleManager.swift`. The two are
 * coupled only by this substring (the bridge surfaces the native error as its
 * message), so keep the literal "write timed out" on both sides. A *recovery
 * give-up* uses a different message (`writeRecoveryFailed`) that deliberately
 * does NOT match here, so an exhausted stall reports as a real failure.
 */
export function isBleWriteTimeoutError(error: unknown): boolean {
  return /write timed out/i.test(errorMessage(error));
}

/**
 * True when a write error is the native iOS BLE manager's *recovery give-up*
 * (`BoardBleError.writeRecoveryFailed`): a write that stalled, was retried via a
 * reconnect cycle `maxWriteStallRecoveries` times, and still couldn't be
 * delivered (#3181). Distinct from a plain `write_failed` so the recovery give-up
 * rate is directly measurable in PostHog (`write_timeout` = stalls encountered,
 * `write_recovery_failed` = stalls recovery couldn't fix). It is deliberately NOT
 * a disconnection (see [[isDisconnectionError]]) so the JS write-failure path
 * doesn't clear the stored board the lightbulb reconnects to.
 *
 * CONTRACT: matched against `BoardBleError.writeRecoveryFailed.errorDescription`
 * in `packages/mobile/modules/live-activity/ios/BoardBleManager.swift`. If the
 * native message changes without updating this, the give-up degrades gracefully
 * to `write_failed` (the metric blurs; nothing breaks).
 */
export function isBleWriteRecoveryFailedError(error: unknown): boolean {
  return /recovery attempts were exhausted/i.test(errorMessage(error));
}

/**
 * Classify an error thrown from a *send* (BLE write) into a `failureReason` for
 * the `Climb Sent to Board Failure` event. The dominant real cause on these
 * last-connection-wins boards is a mid-session disconnect — surfacing it as
 * `disconnected` (instead of a generic bucket) is what makes the reliability gap
 * visible in analytics. Pure TS so both the web and mobile hooks share one
 * source of truth. DOMException is feature-detected because the native iOS /
 * Android RN adapters run where it may be undefined.
 */
export function classifyBleFailureReason(error: unknown): BleSendFailureReason {
  if (isDisconnectionError(error)) return 'disconnected';
  // The recovery give-up is checked before the plain write-timeout: it is a
  // distinct, terminal outcome (#3181), and its message intentionally does not
  // match the /write timed out/ pattern, but keep the order explicit.
  if (isBleWriteRecoveryFailedError(error)) return 'write_recovery_failed';
  // A write-resume timeout the native layer is auto-recovering (#3181) — its own
  // bucket so recovery rate is visible instead of hiding in `write_failed`.
  if (isBleWriteTimeoutError(error)) return 'write_timeout';
  // `convertToMirroredFramesString` throws this when a hold has no mirrored id.
  if (error instanceof Error && error.message.includes('Mirrored hold ID')) return 'missing_mirror_mapping';
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return `dom_${error.name || 'exception'}`;
  }
  return 'write_failed';
}
