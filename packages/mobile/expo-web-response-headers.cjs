const EXPO_WEB_ROBOTS_VALUE = 'noindex, follow';
const EXPO_WEB_SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function isExpoWebAppRequest(webFlag, rawUrl) {
  if (webFlag !== '1' || !rawUrl) return false;

  const pathName = rawUrl.split('?')[0]?.toLowerCase();
  return pathName === '/app' || pathName?.startsWith('/app/') === true;
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
  applyExpoWebResponseHeaders,
  isExpoWebAppRequest,
};
