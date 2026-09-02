// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';
import { SUPPORTED_BOARDS } from './app/lib/board-data';
import { getClimbViewPageCacheTTL, getListPageCacheTTL } from './app/lib/list-page-cache';
import { isCrawlerUserAgent } from './app/lib/is-crawler';
import { CLIMB_SESSION_COOKIE } from './app/lib/climb-session-cookie';
import { PATHNAME_HEADER } from './app/lib/request-pathname-header';
import { isSecureCookieContext } from './app/lib/auth/secure-cookies';
import { resolveCrossSubdomainAuthCors } from './app/lib/auth/cross-subdomain-cors';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_HEADER,
  SUPPORTED_LOCALES,
  isSupportedLocale,
} from './app/lib/i18n/config';
import { detectLocale } from './app/lib/i18n/detect-locale';

const SPECIAL_ROUTES = ['angles', 'grades']; // routes that don't need board validation

// Locale-prefixed embed URLs (/es/embed/..., /fr/embed/...) are 308'd to the
// un-prefixed path (see the carve-out below). Derived from SUPPORTED_LOCALES
// so adding a locale can't silently leave its prefixed embeds on the
// frame-denying header rule. Case-insensitive to match the case-insensitive
// next.config header matchers.
const LOCALE_PREFIXED_EMBED_PATTERN = new RegExp(
  `^/(${SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).join('|')})/embed/`,
  'i',
);

// Expo web owns /app whenever the app is enabled — in dev via the Metro proxy,
// and in a static-serve deployment (no proxy origin) too. Scoped narrower than
// the general middleware so a deployment without Expo web leaves /app to normal
// routing.
function isExpoWebEnabled(): boolean {
  return process.env.BOARDSESH_WEB === '1';
}

// The /assets and /packages/mobile Metro namespaces only exist behind the dev
// proxy, so they additionally require the proxy origin.
function isExpoWebProxyEnabled(): boolean {
  return isExpoWebEnabled() && Boolean(process.env.BOARDSESH_EXPO_WEB_ORIGIN);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Block PHP requests
  if (pathname.includes('.php')) {
    return new NextResponse(null, {
      status: 404,
      statusText: 'Not Found',
    });
  }

  // Credentialed cross-subdomain CORS for the standalone Expo-web app
  // (app.boardsesh.com), which reads the shared `.boardsesh.com` session by
  // calling www's auth + ws-auth endpoints cross-origin with credentials. Only
  // an allowed app origin is echoed (never `*`); every other request — including
  // same-origin www requests — resolves to `null` here and flows on unchanged.
  const crossSubdomainAuthCors = resolveCrossSubdomainAuthCors(request);
  if (crossSubdomainAuthCors && 'preflight' in crossSubdomainAuthCors) {
    return crossSubdomainAuthCors.preflight;
  }

  // Expo web owns /app as a locale-neutral authenticated utility surface.
  // Bypass sticky-locale and legacy session handling so the Next rewrite keeps
  // this exact path and the HttpOnly NextAuth cookie remains same-origin.
  const lowercasePathname = pathname.toLowerCase();
  if (isExpoWebEnabled() && (lowercasePathname === '/app' || lowercasePathname.startsWith('/app/'))) {
    const expoWebRequestHeaders = new Headers(request.headers);
    expoWebRequestHeaders.set(LOCALE_HEADER, DEFAULT_LOCALE);
    const expoWebResponse = NextResponse.next({ request: { headers: expoWebRequestHeaders } });
    // External rewrites forward the Expo response headers and can bypass the
    // matching next.config header rule. Attach noindex in middleware as well so
    // the actual proxied response remains a utility surface in development and
    // in any future same-origin deployment.
    expoWebResponse.headers.set('X-Robots-Tag', 'noindex, follow');
    // External rewrites can also replace next.config's global response headers.
    // Keep the authenticated SPA frame-protected at the middleware boundary;
    // Metro repeats these headers so direct development requests match.
    expoWebResponse.headers.set('X-Frame-Options', 'SAMEORIGIN');
    expoWebResponse.headers.set('X-Content-Type-Options', 'nosniff');
    expoWebResponse.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // HSTS only in a secure (HTTPS) context — matching the climb-session cookie's
    // Secure gate. Over local http it's ignored anyway, and Metro deliberately
    // never sends it for direct dev requests.
    if (isSecureCookieContext()) {
      expoWebResponse.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return expoWebResponse;
  }

  // Metro emits browser bundle and resolved-asset URLs from these root-level
  // namespaces. When the matching Next rewrites are enabled, keep them out of
  // locale and legacy-session handling so their query strings reach Metro
  // unchanged. Preserve the normal Next middleware behavior when the Expo
  // proxy is not fully configured.
  const isExpoWebSupportPath =
    lowercasePathname === '/assets' ||
    lowercasePathname.startsWith('/assets/') ||
    lowercasePathname === '/packages/mobile' ||
    lowercasePathname.startsWith('/packages/mobile/');
  if (isExpoWebSupportPath && isExpoWebProxyEnabled()) {
    const expoWebRequestHeaders = new Headers(request.headers);
    expoWebRequestHeaders.set(LOCALE_HEADER, DEFAULT_LOCALE);
    return NextResponse.next({ request: { headers: expoWebRequestHeaders } });
  }

  // /embed/** — iframe widgets for gym websites: display-only, cookieless,
  // anonymous. Bypass BEFORE the ?session= branch and locale detection so no
  // sticky-locale/session cookie (or any other cookie) is ever set on an
  // embed response, and no locale redirect/rewrite can move the request off
  // the /embed/** path that the next.config.mjs `frame-ancestors *` header
  // rule matches on.
  //
  // Case-INsensitive on purpose: next.config `headers()` sources compile
  // case-insensitively, so /EMBED/board/x already receives the frameable
  // embed headers — this carve-out must cover the same set of paths or a
  // case-drifted request (e.g. /EMBED/...?session=abc) would run the full
  // pipeline and could Set-Cookie on a frameable response.
  if (lowercasePathname === '/embed' || lowercasePathname.startsWith('/embed/')) {
    // Embeds render en-US only: overwrite the locale request header instead
    // of forwarding it, so a crafted client-supplied x-boardsesh-locale can't
    // pick the rendered locale (everywhere else the middleware overwrites
    // this header; the carve-out must too).
    const embedRequestHeaders = new Headers(request.headers);
    embedRequestHeaders.set(LOCALE_HEADER, DEFAULT_LOCALE);
    return NextResponse.next({ request: { headers: embedRequestHeaders } });
  }

  // Locale-prefixed embed URLs are 308'd to the un-prefixed path: headers()
  // matches the ORIGINAL request path, so /es/embed/** would dodge the embed
  // header rule and be served frame-DENYING X-Frame-Options: SAMEORIGIN.
  // Embeds are en-US-only by design.
  const localePrefixedEmbed = pathname.match(LOCALE_PREFIXED_EMBED_PATTERN);
  if (localePrefixedEmbed) {
    const unprefixedEmbedUrl = request.nextUrl.clone();
    unprefixedEmbedUrl.pathname = pathname.slice(localePrefixedEmbed[1].length + 1);
    return NextResponse.redirect(unprefixedEmbedUrl, 308);
  }

  // Check API routes
  if (pathname.startsWith('/api/v1/')) {
    const pathParts = pathname.split('/');
    if (pathParts.length >= 4) {
      const routeIdentifier = pathParts[3].toLowerCase(); // either a board name or special route

      // Allow special routes to pass through
      if (SPECIAL_ROUTES.includes(routeIdentifier)) {
        return NextResponse.next();
      }

      // For all other routes, validate board name
      if (!(SUPPORTED_BOARDS as readonly string[]).includes(routeIdentifier)) {
        return new NextResponse(null, {
          status: 404,
          statusText: 'Not Found',
        });
      }
    }
  }

  // Backward compat: redirect old ?session= URLs to clean URLs with cookie.
  // The redirect cost (~150ms) is far less than a CDN cache miss (1.3-1.6s).
  const sessionParam = request.nextUrl.searchParams.get('session');
  if (sessionParam) {
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete('session');
    const response = NextResponse.redirect(cleanUrl, 307);
    response.cookies.set(CLIMB_SESSION_COOKIE, sessionParam, {
      path: '/',
      sameSite: 'lax',
      // Mark Secure on HTTPS deployments so the cookie is never sent over
      // plaintext; skipped in local http dev so it still round-trips there.
      secure: isSecureCookieContext(),
      maxAge: 86400,
    });
    return response;
  }

  // Detect locale from URL prefix. API routes don't carry a locale prefix —
  // skip them so we don't mangle their paths.
  const isApi = pathname.startsWith('/api/');
  const { locale, strippedPath, needsRewrite } = isApi
    ? { locale: DEFAULT_LOCALE, strippedPath: pathname, needsRewrite: false }
    : detectLocale(pathname);

  // Classify once for the two sticky-locale gates below. Skipped outright for
  // /api/*: the `/api/v1/:path*` and `/api/auth/:path*` matcher entries do
  // reach this line, but `isApi` above pins their locale to DEFAULT_LOCALE, so
  // neither gate can fire for them and classifying would be pure cost.
  const isCrawler = isApi ? false : isCrawlerUserAgent(request.headers.get('user-agent'));

  // Cookie-driven sticky locale: when a page request arrives without a locale
  // prefix and the visitor previously chose a non-default locale, send them
  // to the prefixed URL so subsequent navigation stays in their language.
  //
  // Crawlers are excluded: ones that persist cookies (observed in production
  // logs) acquire the boardsesh-locale cookie by crawling a /de|/es|/fr page
  // once, then bounce every subsequent unprefixed URL through a locale twin —
  // ~15k of these 307s/day, plus the render MISS on the twin they land on.
  // Crawlers get a default-locale 200 for the URL they requested instead.
  //
  // The classifier is ours, not Next's `userAgent(request).isBot`: Next's list
  // names no scraper newer than ~2023, and AhrefsBot, SemrushBot, DataForSeoBot
  // and MJ12bot were all still taking this 307 in production on 2026-08-24. See
  // `app/lib/is-crawler.ts` for the token list and the probe behind it.
  if (!isApi && locale === DEFAULT_LOCALE && !isCrawler) {
    const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
    if (isSupportedLocale(cookieLocale) && cookieLocale !== DEFAULT_LOCALE) {
      const target = new URL(`/${cookieLocale}${pathname}`, request.url);
      target.search = request.nextUrl.search;
      // 307 (not 308): browsers cache 308 indefinitely, so a user who
      // clears their locale cookie would still be redirected to /es/...
      // from the browser cache. 307 is revalidated on every request.
      return NextResponse.redirect(target, 307);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(LOCALE_HEADER, locale);
  // Expose the routing pathname to server layouts, which don't otherwise see
  // their child route segment. The board `[angle]` layout reads it to leave a
  // legacy numeric `/view/` or `/play/` URL to the child page's own
  // climb-preserving redirect. Overwrite (never append) so a client-supplied
  // value can't reach the layout.
  requestHeaders.set(PATHNAME_HEADER, strippedPath);

  let response: NextResponse;
  if (needsRewrite) {
    const rewrittenUrl = request.nextUrl.clone();
    rewrittenUrl.pathname = strippedPath;
    response = NextResponse.rewrite(rewrittenUrl, {
      request: { headers: requestHeaders },
    });
  } else {
    response = NextResponse.next({
      request: { headers: requestHeaders },
    });
  }

  // Sticky cookie: any visit on a non-default locale URL writes the cookie so
  // a shared /es/... link from a friend persists for the recipient too.
  // Crawlers never acquire it — see the sticky-locale redirect gate above for
  // why a cookie-persisting crawler must never be handed this cookie.
  if (locale !== DEFAULT_LOCALE && !isCrawler) {
    response.cookies.set(LOCALE_COOKIE, locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  // Use Vercel-CDN-Cache-Control because Next.js overwrites Cache-Control
  // for dynamic pages (pages that use searchParams) with "private, no-store".
  // Vercel-CDN-Cache-Control is the highest-priority header for Vercel's CDN
  // and is not touched by Next.js rendering.
  // Cache-key follows the original (locale-prefixed) URL, so en and es never collide.
  // Climb view pages are equally URL-determined and personalization-free, so they
  // cache the same way — including their legacy numeric variants, whose permanent
  // redirect the CDN can then serve without re-rendering.
  const cacheTTL =
    getListPageCacheTTL(strippedPath, request.nextUrl.searchParams) ??
    getClimbViewPageCacheTTL(strippedPath, request.nextUrl.searchParams);
  if (cacheTTL !== null) {
    const cdnCacheValue = `s-maxage=${cacheTTL}, stale-while-revalidate=${cacheTTL * 7}`;
    response.headers.set('Vercel-CDN-Cache-Control', cdnCacheValue);
    response.headers.set('CDN-Cache-Control', cdnCacheValue);
  }

  // Attach the credentialed CORS headers to the eventual auth-endpoint response
  // when the request came from an allowed app origin (see the preflight branch
  // near the top). No-op for every other request.
  if (crossSubdomainAuthCors && 'applyHeaders' in crossSubdomainAuthCors) {
    crossSubdomainAuthCors.applyHeaders(response);
  }

  return response;
}

// Vercel bills and logs per middleware invocation. The previous catch-all
// matcher (`/api/:path*`-shaped, via the page-routes negative-lookahead not
// excluding /api/) ran this middleware on every /api/** request, including
// ~50k+/day board-render image fetches that take nothing from it — the
// function does no locale/session/CORS work for those paths and every
// invocation was pure cost. Only three /api families actually need it:
//   - /api/v1/:path* — board-name validation (404s an unsupported board).
//   - /api/auth/:path* — all 9 CORS_AUTH_PATHS auth endpoints live here
//     (see cross-subdomain-cors.ts) and need the credentialed-CORS handling.
//   - /api/internal/ws-auth — the one /api/internal path in CORS_AUTH_PATHS;
//     its OPTIONS preflight is answered by middleware itself, so it must stay
//     matched even though the rest of /api/internal/** is now excluded.
// Pre-verified safe: no route under packages/web/app/api reads the
// locale/pathname headers middleware sets, and nothing excluded here accepts
// a `?session=` query param that middleware needs to intercept.
export const config = {
  matcher: [
    '/api/v1/:path*',
    '/api/auth/:path*',
    '/api/internal/ws-auth',
    // Match all page routes but skip static files, Next.js internals, and
    // /.well-known/ (apple-app-site-association, assetlinks.json — files the
    // OS fetches, which must never take a locale redirect or a rewrite).
    '/((?!api/|_next/static|_next/image|favicon.ico|monitoring|\\.well-known/|.*\\..*).*)',
  ],
};
