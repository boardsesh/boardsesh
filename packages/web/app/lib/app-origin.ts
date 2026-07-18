import { DEFAULT_APP_ORIGIN } from '@boardsesh/shared-schema/app-origins';

/**
 * Origin of the Expo-web app (app.boardsesh.com). The "Start climbing" CTA links
 * every visitor straight to this origin. There's no token hand-off: www and app
 * share a `.boardsesh.com` HttpOnly NextAuth session cookie, so a logged-in
 * visitor lands on the app already authenticated and a logged-out visitor gets
 * the app's own login.
 *
 * NEXT_PUBLIC_ prefix so the value is inlined into the client bundle for the CTA
 * link. The shared prod default keeps the CTA pointing at the live app even when
 * the env var is unset.
 */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_ORIGIN;
