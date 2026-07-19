// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';
import { SUPPORTED_BOARDS } from './app/lib/board-data';
import { getListPageCacheTTL } from './app/lib/list-page-cache';
import { CLIMB_SESSION_COOKIE } from './app/lib/climb-session-cookie';
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
import {
  EXPO_WEB_CLASSIC_COOKIE,
  EXPO_WEB_CLASSIC_PARAM,
  hasAuthSessionCookie,
  hasClassicOptOutCookie,
  isExpoWebFlagCookieOn,
  isExpoWebRolloutEnabled,
  mapToExpoWebTarget,
} from './app/lib/expo-web-rollout';

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
        console.info('Middleware board_name check returned 404');
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

  // Expo-web rollout: route logged-in visitors on migrated board surfaces to
  // the /app Expo-web SPA, gated on BOARDSESH_WEB=1 AND the mirrored
  // `expo-web-app` flag cookie AND a next-auth session. Off in every dimension
  // by default — a logged-out visitor, a crawler, or a visitor whose flag
  // hasn't resolved never redirects, so public/SEO board views stay canonical.
  // Runs before locale detection so a migrated surface makes at most one hop
  // straight to the locale-neutral /app SPA (no locale bounce first).
  if (isExpoWebRolloutEnabled()) {
    // Escape hatch: `?classic=1` pins the bs_classic cookie and lands the
    // visitor back on the classic URL (param stripped), mirroring the ?session=
    // handling above. From then on the cookie alone forces classic. API routes
    // are exempt — a `classic` query param on `/api/...` (e.g. an Aurora proxy
    // call) is that endpoint's own business, and 307-ing an API request to a
    // param-stripped URL would corrupt it.
    if (!pathname.startsWith('/api/') && request.nextUrl.searchParams.get(EXPO_WEB_CLASSIC_PARAM) !== null) {
      const classicUrl = request.nextUrl.clone();
      classicUrl.searchParams.delete(EXPO_WEB_CLASSIC_PARAM);
      const classicResponse = NextResponse.redirect(classicUrl, 307);
      classicResponse.cookies.set(EXPO_WEB_CLASSIC_COOKIE, '1', {
        path: '/',
        sameSite: 'lax',
        // Secure in https/prod contexts, mirroring the next-auth session
        // cookie (see secure-cookies.ts); plain on http localhost so the
        // escape hatch still works in dev.
        secure: isSecureCookieContext(),
        maxAge: 60 * 60 * 24 * 365,
      });
      return classicResponse;
    }

    // A query string on a classic board URL is filter/search state (?minGrade,
    // ?name, ?sortBy, …) the /app SPA does not read from the URL — redirecting
    // would silently drop it, so shared filtered links are served classic.
    const hasClassicQueryState = request.nextUrl.search !== '';

    if (
      !hasClassicQueryState &&
      !hasClassicOptOutCookie(request) &&
      isExpoWebFlagCookieOn(request) &&
      hasAuthSessionCookie(request)
    ) {
      const expoWebTarget = mapToExpoWebTarget(pathname);
      if (expoWebTarget) {
        // 307 (not 308): the flag can flip off at any time, so the redirect
        // must never be cached by the browser as permanent.
        return NextResponse.redirect(new URL(expoWebTarget, request.url), 307);
      }
    }
  }

  // Detect locale from URL prefix. API routes don't carry a locale prefix —
  // skip them so we don't mangle their paths.
  const isApi = pathname.startsWith('/api/');
  const { locale, strippedPath, needsRewrite } = isApi
    ? { locale: DEFAULT_LOCALE, strippedPath: pathname, needsRewrite: false }
    : detectLocale(pathname);

  // Cookie-driven sticky locale: when a page request arrives without a locale
  // prefix and the visitor previously chose a non-default locale, send them
  // to the prefixed URL so subsequent navigation stays in their language.
  if (!isApi && locale === DEFAULT_LOCALE) {
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
  if (locale !== DEFAULT_LOCALE) {
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
  const cacheTTL = getListPageCacheTTL(strippedPath, request.nextUrl.searchParams);
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

export const config = {
  matcher: [
    '/api/v1/:path*',
    // Match all page routes but skip static files, Next.js internals, and Vercel Flags Explorer
    '/((?!_next/static|_next/image|favicon.ico|monitoring|\\.well-known/|.*\\..*).*)',
  ],
};
