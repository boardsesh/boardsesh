import { Redirect, usePathname } from 'expo-router';
import { isSameOriginPath } from '../src/lib/routing/same-origin-path';
import { stripLocalePrefix } from '../src/lib/routing/strip-locale-prefix';

/**
 * Last stop for a URL no route matched — including a canonical board link that
 * still carries the web app's locale prefix (`/es/kilter/original/…`). The Expo
 * route tree has no `[locale]` segment, so those land here; retrying without the
 * prefix is what makes a Spanish or French climber's shared link open the same
 * climb an English one does. Only paths that already failed to match reach this
 * route, so the retry can never shadow a real one.
 *
 * `usePathname()` is attacker-controlled and already decoded twice, so what is left
 * after the strip can be `//evil.example`, which the router would open as an
 * external URL. Anything that is not a same-origin path goes Home instead.
 */
export default function NotFound() {
  const pathname = usePathname();
  const withoutLocale = stripLocalePrefix(pathname);
  return <Redirect href={isSameOriginPath(withoutLocale) ? withoutLocale : '/(tabs)/home'} />;
}
