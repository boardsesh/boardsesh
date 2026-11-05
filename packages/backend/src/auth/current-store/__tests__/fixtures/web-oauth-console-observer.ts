export interface WebOAuthConsoleObservation {
  profileRefreshUnavailable: number;
  identityErrors: number;
  identityWarnings: number;
  unknownArguments: number;
}

/** Test-child I/O observation only. No raw console argument is retained or forwarded. */
export function installWebOAuthConsoleObserver() {
  const counts: WebOAuthConsoleObservation = {
    profileRefreshUnavailable: 0,
    identityErrors: 0,
    identityWarnings: 0,
    unknownArguments: 0,
  };
  // Exact canonical records reject extra fields and duplicate-key payloads
  // without parsing, traversing or serializing arbitrary private arguments.
  const allowed = new Map<string, Exclude<keyof WebOAuthConsoleObservation, 'unknownArguments'>>([
    [JSON.stringify({ event: 'auth_profile_refresh_unavailable', phase: 'jwt' }), 'profileRefreshUnavailable'],
    [JSON.stringify({ event: 'web_oauth_identity_error', phase: 'framework' }), 'identityErrors'],
    [JSON.stringify({ event: 'web_oauth_identity_warning', phase: 'framework' }), 'identityWarnings'],
  ]);
  // oxlint-disable-next-line no-console -- Test-child boundary observation; no message emission.
  const originalWarn = console.warn;
  const observedWarn: typeof console.warn = (...arguments_: unknown[]): void => {
    if (arguments_.length === 1 && typeof arguments_[0] === 'string' && arguments_[0].length <= 128) {
      const key = allowed.get(arguments_[0]);
      if (key) {
        counts[key] += 1;
        return;
      }
    }
    counts.unknownArguments += 1;
  };
  // oxlint-disable-next-line no-console -- Install only in the owned identity-test child.
  console.warn = observedWarn;
  return {
    snapshot: (): WebOAuthConsoleObservation => ({ ...counts }),
    restore(): void {
      // oxlint-disable-next-line no-console -- Restore only this test observer's own boundary.
      if (console.warn === observedWarn) console.warn = originalWarn;
    },
  };
}
