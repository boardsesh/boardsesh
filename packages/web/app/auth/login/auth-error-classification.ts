// NextAuth's documented error codes. The ?error= query param is user-supplied
// (anyone can craft a URL), so we whitelist before forwarding to analytics so
// the failure_reason property doesn't carry arbitrary attacker-controlled
// strings into PostHog.
const KNOWN_AUTH_ERRORS: ReadonlySet<string> = new Set([
  'Configuration',
  'AccessDenied',
  'Verification',
  'Default',
  'OAuthSignin',
  'OAuthCallback',
  'OAuthCreateAccount',
  'OAuthEmailRequired',
  'OAuthAccountNotLinked',
  'EmailCreateAccount',
  'EmailSignin',
  'Callback',
  'CredentialsSignin',
  'SessionRequired',
]);

export function safeAuthError(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return KNOWN_AUTH_ERRORS.has(value) ? value : 'unknown';
}

// CredentialsSignin is NextAuth's code for a credentials provider rejection
// that bounced back as ?error=. Every other code in the enum originates from
// an OAuth round-trip (provider rejection, callback mismatch, account-link).
// Without this branch, ?error=CredentialsSignin events would be miscounted in
// the OAuth conversion funnel.
export function authMethodFromError(value: string | null | undefined): 'credentials' | 'oauth' {
  return value === 'CredentialsSignin' ? 'credentials' : 'oauth';
}
