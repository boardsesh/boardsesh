import {
  BROWSER_SESSION_MODE_ENV,
  parseBrowserSessionMode,
  type BrowserSessionMode,
} from '@boardsesh/auth-protocol/browser-session-mode';

export { BROWSER_SESSION_MODES, type BrowserSessionMode } from '@boardsesh/auth-protocol/browser-session-mode';

type Environment = Readonly<Record<string, string | undefined>>;

/** Unset or empty is `legacy`. Any other unknown value throws. */
export function readBrowserSessionMode(
  rawMode: string | undefined = process.env[BROWSER_SESSION_MODE_ENV],
): BrowserSessionMode {
  return parseBrowserSessionMode(rawMode);
}

/**
 * Checked once at startup, before anything listens. An unknown value refuses
 * to start, so a typo fails the deploy visibly. In Phase A of #7596 nothing
 * serves a Better Auth browser session, so `better-auth` refuses too. B1
 * replaces that refusal with its own startup preconditions.
 */
export function assertBrowserSessionModeConfiguration(environment: Environment = process.env): void {
  if (readBrowserSessionMode(environment[BROWSER_SESSION_MODE_ENV]) === 'legacy') return;
  throw new Error(
    'AUTH_BROWSER_SESSION_MODE=better-auth refused: B1 (#7596) has not landed, so nothing serves a Better Auth browser session',
  );
}
