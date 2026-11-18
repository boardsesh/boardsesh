/**
 * `AUTH_BROWSER_SESSION_MODE`, the one switch for the browser session cutover
 * on www and app.boardsesh.com (#7596). `legacy` keeps today's NextAuth
 * session; `better-auth` moves browsers to the backend's Better Auth session.
 *
 * Only the backend reads it so far. On `better-auth` it checks its startup
 * preconditions and then still refuses until the later Phase B PRs land. www
 * gets its own server-side reader in B4. It is never a `NEXT_PUBLIC_*` value,
 * because those are fixed at build time and a rollback would need a rebuild.
 */
export const BROWSER_SESSION_MODE_ENV = 'AUTH_BROWSER_SESSION_MODE';

export const BROWSER_SESSION_MODES = ['legacy', 'better-auth'] as const;

export type BrowserSessionMode = (typeof BROWSER_SESSION_MODES)[number];

/**
 * An absent or empty value is `legacy`. Anything else that is not exactly one
 * of the two modes throws, so a typo stops the deploy instead of quietly
 * choosing a session. The error never repeats the value.
 */
export function parseBrowserSessionMode(rawMode: string | undefined): BrowserSessionMode {
  if (rawMode === undefined || rawMode === '') return 'legacy';
  const mode = BROWSER_SESSION_MODES.find((candidate) => candidate === rawMode);
  if (!mode) throw new Error('AUTH_BROWSER_SESSION_MODE_INVALID');
  return mode;
}
