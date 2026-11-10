/**
 * Pure telemetry redaction for legacy and versioned password-recovery and
 * email-verification capabilities, and for a partner app's signed OAuth request
 * on the www sign-in and consent pages (`/oauth/sign-in`, `/oauth/consent`).
 */
const RECOVERY_PATH =
  /(?:\/|%(?:25)*2f)(?:auth(?:\/|%(?:25)*2f)(?:reset-password|forgot-password|verify-email)|oauth(?:\/|%(?:25)*2f)(?:sign-in|consent))(?:(?:\/|%(?:25)*2f))?(?=\?|#|%(?:25)*(?:3f|23)|$)/i;
const RECOVERY_URL =
  /((?:\/|%(?:25)*2f)(?:auth(?:\/|%(?:25)*2f)(?:reset-password|forgot-password|verify-email)|oauth(?:\/|%(?:25)*2f)(?:sign-in|consent))(?:(?:\/|%(?:25)*2f))?)([?#]|%(?:25)*(?:3f|23))([^\s"'<>\\]*)/gi;
const VERSIONED_SECRET = /\b(?:pr|ev)\d+_[A-Za-z0-9_-]+/gi;
const REDACTED = '[redacted]';
const QUERY_FIELDS = new Set(['query_string', 'http.query', 'url.query', 'http.fragment', 'url.fragment']);
const RECOVERY_FIELDS = new Set(['token', 'email', 'password', 'confirmpassword', 'recipient']);
/** Body fields that are secrets wherever they appear. `oauth_query` is the consent pages' signed request. */
const SECRET_FIELD = /^(?:token|password|confirmPassword|oauth_query)$/i;

function decodedName(name: string): string {
  const characters: string[] = [];
  // Each input character is pushed once. Every reduction removes two entries,
  // including newly formed overlaps: total work is linear, without a depth cap.
  for (const character of name) {
    characters.push(character === '+' ? ' ' : character);
    while (characters.length >= 3) {
      const last = characters.length - 1;
      if (characters[last - 2] !== '%') break;
      const octet = characters[last - 1] + characters[last];
      if (!/^[\da-f]{2}$/i.test(octet)) break;
      characters.length -= 2;
      characters[characters.length - 1] = String.fromCharCode(Number.parseInt(octet, 16));
    }
  }
  return characters.join('').toLowerCase();
}

/** One classification policy for structured recovery request bodies. */
function isRecoveryField(name: string): boolean {
  return RECOVERY_FIELDS.has(decodedName(name));
}

/**
 * A recognized recovery or verification URL loses its entire query/fragment,
 * including nested capabilities and attribution. Reserved prN_ and evN_
 * capabilities are also masked in free text. URLs carrying neither stay
 * byte-for-byte unchanged.
 * No dynamic regex compilation, recursive interpretation or depth cap.
 */
export function redactPasswordRecoveryUrls(text: string): string {
  return text
    .replace(RECOVERY_URL, (_match, path: string, marker: string) => `${path}${marker}${REDACTED}`)
    .replace(VERSIONED_SECRET, REDACTED);
}

function isPlainObject(input: object): input is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Covers SDK URL/referrer fields, breadcrumbs, spans and structured credential bodies.
 * Dates/classes remain intact. Clone changed events without retaining secret-bearing cycle edges.
 */
export function scrubPasswordRecoveryEvent<TEvent>(event: TEvent): TEvent {
  let changed = false;
  const copies = new WeakMap<object, unknown>();
  const sensitiveObjects = new WeakSet<object>();
  const queryObjects = new WeakSet<object>();
  const visitedContexts = new WeakMap<object, number>();
  const hasRecoveryUrl = (input: Record<string, unknown>) =>
    ['url', 'url.full', 'http.url'].some(
      (key) => typeof input[key] === 'string' && RECOVERY_PATH.test(input[key] as string),
    );
  const hasCredentials = (input: Record<string, unknown>) =>
    Object.hasOwn(input, 'password') ||
    Object.hasOwn(input, 'confirmPassword') ||
    (Object.hasOwn(input, 'token') && (Object.hasOwn(input, 'email') || Object.hasOwn(input, 'recipient')));
  // Discover all sensitive paths first: a shared object reached earlier through
  // ordinary metadata must not retain a secret when later reused as a body.
  function mark(input: unknown, inherited = false, query = false): void {
    if (typeof input !== 'object' || input === null || (!Array.isArray(input) && !isPlainObject(input))) return;
    const context = inherited || (!Array.isArray(input) && (hasRecoveryUrl(input) || hasCredentials(input)));
    const flags = (context ? 1 : 0) | (query ? 2 : 0);
    const previous = visitedContexts.get(input);
    if (previous !== undefined && (previous | flags) === previous) return;
    visitedContexts.set(input, (previous ?? 0) | flags);
    if (context) sensitiveObjects.add(input);
    if (query) queryObjects.add(input);
    for (const [key, item] of Object.entries(input)) mark(item, context, query || (context && QUERY_FIELDS.has(key)));
  }
  mark(event);
  function scrub(input: unknown, recoveryContext = false, queryContext = false): unknown {
    // Strongest discovered query context wins even for an earlier object alias.
    // SDK string/map/tuple representations all collapse to the same safe value.
    if (
      input !== null &&
      input !== undefined &&
      (queryContext || (typeof input === 'object' && queryObjects.has(input)))
    ) {
      if (input !== REDACTED) changed = true;
      return REDACTED;
    }
    if (typeof input === 'string') {
      let next = redactPasswordRecoveryUrls(input);
      // Some SDKs retain a serialized request body or flags payload.
      if (/^\s*[[{]/.test(next)) {
        try {
          const parsed: unknown = JSON.parse(next);
          mark(parsed, recoveryContext);
          const before = changed;
          const scrubbed = scrub(parsed, recoveryContext);
          if (changed !== before || JSON.stringify(scrubbed) !== JSON.stringify(parsed))
            next = JSON.stringify(scrubbed);
        } catch {
          // Non-JSON messages still receive whole recovery-URL scrubbing.
        }
      }
      if (next !== input) changed = true;
      return next;
    }
    if (typeof input !== 'object' || input === null) return input;
    if (copies.has(input)) return copies.get(input);
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      copies.set(input, result);
      for (const item of input) result.push(scrub(item, recoveryContext || sensitiveObjects.has(input)));
      return result;
    }
    if (!isPlainObject(input)) return input;
    const context = recoveryContext || sensitiveObjects.has(input) || hasRecoveryUrl(input);
    const result: Record<string, unknown> = Object.create(Object.getPrototypeOf(input)) as Record<string, unknown>;
    copies.set(input, result);
    for (const [key, item] of Object.entries(input)) {
      const secretField = SECRET_FIELD.test(key) || (context && isRecoveryField(key));
      const next =
        secretField && item !== null && item !== undefined
          ? REDACTED
          : scrub(item, context, context && QUERY_FIELDS.has(key));
      if (next !== item && secretField) changed = true;
      Object.defineProperty(result, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  const result = scrub(event);
  return (changed ? result : event) as TEvent;
}
