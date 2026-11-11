// One rule for web and backend: trim, then lowercase. It lives in the shared
// protocol package so the web's legacy auth routes apply the same rule.
export { normalizeAccountEmail } from '@boardsesh/auth-protocol/account-email';
