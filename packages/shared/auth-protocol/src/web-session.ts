/**
 * The first-party web session the backend issues (#7596, owner decisions of
 * 2026-11-17). The backend owns the session row; www owns the cookie that
 * carries its token. Both sides read these numbers from here.
 */

/** A session row lives this long after it was issued or last rolled: 30 days. */
export const WEB_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * A row is rolled only once fewer than this many seconds remain: 29 days. So
 * an active session is written at most once a day, and a roll never writes the
 * cookie.
 */
export const WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS = 29 * 24 * 60 * 60;
