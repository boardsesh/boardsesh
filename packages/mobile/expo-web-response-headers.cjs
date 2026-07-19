const EXPO_WEB_ROBOTS_VALUE = 'noindex, follow';
// Always-on security headers. HSTS is intentionally NOT here: it only makes
// sense over HTTPS, and Metro serves dev requests over http://localhost, where a
// Strict-Transport-Security header is at best ignored and at worst poisons other
// localhost http services. The web middleware sets HSTS on /app itself, gated on
// a secure context (see EXPO_WEB_STRICT_TRANSPORT_SECURITY below).
const EXPO_WEB_SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
// The HSTS value the web middleware applies in a secure (HTTPS) context. Kept
// here so the middleware↔Metro parity test has one source for it.
const EXPO_WEB_STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

function isExpoWebAppRequest(webFlag, rawUrl) {
  if (webFlag !== '1' || !rawUrl) return false;

  const pathName = rawUrl.split('?')[0].toLowerCase();
  return pathName === '/app' || pathName.startsWith('/app/');
}

function applyExpoWebResponseHeaders(response, webFlag, rawUrl) {
  if (!isExpoWebAppRequest(webFlag, rawUrl)) return;

  response.setHeader('X-Robots-Tag', EXPO_WEB_ROBOTS_VALUE);
  for (const [name, value] of Object.entries(EXPO_WEB_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

module.exports = {
  EXPO_WEB_ROBOTS_VALUE,
  EXPO_WEB_SECURITY_HEADERS,
  EXPO_WEB_STRICT_TRANSPORT_SECURITY,
  applyExpoWebResponseHeaders,
  isExpoWebAppRequest,
};
