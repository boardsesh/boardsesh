/** A PostgreSQL SQLSTATE: five digits or upper-case letters (`42501`, `57014`, `40P01`). */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** Drizzle wraps the driver's error in `cause`; a few levels is every wrapper we have. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The SQLSTATE of a database error, found on the error or one of its causes,
 * or undefined. Only the five-character code is ever returned: never the
 * message, SQL text or parameters, which can carry a token or a password.
 * For logs that must say why a private command answered `unavailable`.
 */
export function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    current = cause;
  }
  return undefined;
}
