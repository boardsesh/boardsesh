const DEFAULT_MAX_ERROR_LENGTH = 200;

// Turn an arbitrary thrown value into a short, safe string for an analytics
// property. Native errors (e.g. BLE failures) routinely embed absolute file
// paths from the native stack, device identifiers, or long messages — none of
// which belong in a third-party analytics backend. We take the message only,
// redact absolute path-like runs (optionally with a `:line` suffix), and cap the
// length.
export function sanitizeErrorForAnalytics(error: unknown, maxLength: number = DEFAULT_MAX_ERROR_LENGTH): string {
  const message = error instanceof Error ? error.message : String(error);
  // Redact absolute paths like "/Users/x/RNBle.m:142" or "/dev/ttyUSB0" -> "<path>".
  // Anchored to start-of-string or whitespace (kept via the capture group) so a
  // real path token is redacted but ordinary text ("and/or", "kg/m") is not.
  const redacted = message.replace(/(^|\s)\/[\w.\-/]+(?::\d+)?/g, '$1<path>').trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
