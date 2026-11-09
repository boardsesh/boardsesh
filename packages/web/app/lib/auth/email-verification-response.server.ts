import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, isSupportedLocale, LOCALE_COOKIE } from '@/app/lib/i18n/config';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';

export const EMAIL_VERIFICATION_RETRY_SECONDS = 30;

/** These responses originate at a URL carrying a single-use credential. */
export function withEmailVerificationPrivacy<ResponseType extends Response>(response: ResponseType): ResponseType {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('CDN-Cache-Control', 'no-store');
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, follow');
  return response;
}

export function emailVerificationRedirect(request: NextRequest, path: string): NextResponse {
  // The standalone server reports its bind address as request.url.
  return withEmailVerificationPrivacy(
    NextResponse.redirect(new URL(path, resolvePublicAuthOrigin() ?? request.url), 307),
  );
}

export async function emailVerificationUnavailableResponse(request: NextRequest): Promise<NextResponse> {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;
  const { t } = await getServerTranslationForLocale(locale, 'auth');
  // No URL, address, implementation error, or outcome claim is interpolated.
  // The browser stays at the original link for a deliberate retry.
  return withEmailVerificationPrivacy(
    new NextResponse(`${t('verifyRequest.retryUnavailable')}\n`, {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Language': locale,
        'Retry-After': String(EMAIL_VERIFICATION_RETRY_SECONDS),
        Vary: 'Cookie',
      },
    }),
  );
}
