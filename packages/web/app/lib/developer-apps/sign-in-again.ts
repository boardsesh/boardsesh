import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';

/** The developer console, where a fresh sign-in comes back to. */
export const DEVELOPER_CONSOLE_PATH = '/developers/apps';

/**
 * Where the console's "Sign in again" goes, unprefixed for `LocaleLink`: sign
 * out first, because the sign-in page sends someone already signed in straight
 * on, then the ordinary sign-in page, which returns to the console. Both hops
 * keep only a same-origin path (`safeCallbackUrl`), and every path here is a
 * constant, so nothing a request carries can choose where the browser lands.
 */
export function signInAgainPath(locale: Locale): string {
  const signIn = `${localeHref('/auth/login', locale)}?${new URLSearchParams({
    callbackUrl: localeHref(DEVELOPER_CONSOLE_PATH, locale),
  }).toString()}`;
  return `/auth/signout?${new URLSearchParams({ callbackUrl: signIn }).toString()}`;
}
