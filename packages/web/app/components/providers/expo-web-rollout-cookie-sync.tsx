'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { EXPO_WEB_FLAG, setExpoWebEnabledCookie } from '@/app/lib/expo-web-rollout';

/**
 * Bridges the client-evaluated `expo-web-app` PostHog flag to the `bs_expo_web`
 * cookie that middleware reads on the edge (middleware cannot call PostHog). The
 * web app evaluates flags only on the client, so this is how the edge learns a
 * visitor is in the rollout cohort. Renders nothing.
 *
 * Until the flag resolves the value is `undefined` (falsy) and the cookie is
 * cleared, so the first navigation after login always stays on the classic UI —
 * the safe default. Once resolved true the cookie is written and the *next*
 * navigation to a migrated board surface redirects to `/app`. Flip the flag off
 * and the cookie clears on the visitor's next page load, instantly reverting.
 *
 * The cookie's short TTL is refreshed on every classic-side navigation
 * (`pathname` dep — this component lives in the root layout and survives soft
 * navs, so the flag value alone wouldn't re-fire). The `/app` SPA never writes
 * the cookie, which is the rollback guarantee: a visitor living entirely inside
 * `/app` loses the cookie within the TTL, lands back on classic, and re-runs
 * this sync against the current flag state.
 */
export function ExpoWebRolloutCookieSync(): null {
  const expoWebFlagEnabled = useFeatureFlag(EXPO_WEB_FLAG);
  const pathname = usePathname();

  useEffect(() => {
    setExpoWebEnabledCookie(expoWebFlagEnabled === true);
  }, [expoWebFlagEnabled, pathname]);

  return null;
}
