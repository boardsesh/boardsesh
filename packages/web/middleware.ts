// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';
import { SUPPORTED_BOARDS } from './app/lib/board-data';
import { getListPageCacheTTL } from './app/lib/list-page-cache';
import { CLIMB_SESSION_COOKIE } from './app/lib/climb-session-cookie';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER, isSupportedLocale } from './app/lib/i18n/config';
import { detectLocale } from './app/lib/i18n/detect-locale';

const SPECIAL_ROUTES = ['angles', 'grades']; // routes that don't need board validation

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Block PHP requests
  if (pathname.includes('.php')) {
    return new NextResponse(null, {
      status: 404,
      statusText: 'Not Found',
    });
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

  // If the URL has no locale prefix but the user previously chose a non-default
  // locale (cookie set by the language switcher), redirect to the prefixed URL.
  // This makes locale stick across plain `<Link href="/foo">` / `router.push`
  // calls throughout the app without retrofitting every call site.
  if (!isApi && !needsRewrite) {
    const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
    if (isSupportedLocale(cookieLocale) && cookieLocale !== DEFAULT_LOCALE) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = pathname === '/' ? `/${cookieLocale}` : `/${cookieLocale}${pathname}`;
      return NextResponse.redirect(redirectUrl, 307);
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

  return response;
}

export const config = {
  matcher: [
    '/api/v1/:path*',
    // Match all page routes but skip static files, Next.js internals, and Vercel Flags Explorer
    '/((?!_next/static|_next/image|favicon.ico|monitoring|\\.well-known/|.*\\..*).*)',
  ],
};
