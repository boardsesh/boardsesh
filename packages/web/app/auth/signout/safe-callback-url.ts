/**
 * Reduce a `?callbackUrl=` value to a safe same-origin relative path, so a
 * crafted value can never turn the sign-out redirect into an open redirect.
 * Only a path beginning with a single `/` is honoured; anything else — absolute
 * URLs, `javascript:` and other schemes, protocol-relative `//host`, and the
 * backslash variant `/\host` (browsers normalise `\` to `/`) — falls back to
 * the app root.
 */
export function safeCallbackUrl(rawCallbackUrl: string | null | undefined): string {
  if (!rawCallbackUrl || rawCallbackUrl[0] !== '/') return '/';
  const secondChar = rawCallbackUrl[1];
  if (secondChar === '/' || secondChar === '\\') return '/';
  return rawCallbackUrl;
}
