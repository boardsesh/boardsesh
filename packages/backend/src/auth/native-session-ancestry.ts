/** An issuer-owned namespace in existing opaque text SID fields. Never infer a fresh proof from it. */
export const UNKNOWN_WEB_NATIVE_SESSION_PREFIX = 'credential-web:v1:';
const RESERVED_NATIVE_SESSION_PREFIX = 'credential-web:';
const canonicalUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** null refuses malformed/unknown versions inside the reserved namespace. */
export function nativeSessionRequiresAccountCutoff(sessionId: string): boolean | null {
  if (!sessionId || sessionId.length > 256) return null;
  const trimmed = sessionId.trim();
  if (!trimmed.startsWith(RESERVED_NATIVE_SESSION_PREFIX)) return trimmed ? false : null;
  if (trimmed !== sessionId || !sessionId.startsWith(UNKNOWN_WEB_NATIVE_SESSION_PREFIX)) return null;
  return canonicalUuidV4.test(sessionId.slice(UNKNOWN_WEB_NATIVE_SESSION_PREFIX.length)) ? true : null;
}
