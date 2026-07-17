'use client';

import { useEffect } from 'react';
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
 */
export function ExpoWebRolloutCookieSync(): null {
  const expoWebFlagEnabled = useFeatureFlag(EXPO_WEB_FLAG);

  useEffect(() => {
    setExpoWebEnabledCookie(expoWebFlagEnabled === true);
  }, [expoWebFlagEnabled]);

  return null;
}
