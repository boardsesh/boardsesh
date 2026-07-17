/**
 * Origin of the Expo-web app (app.boardsesh.com). The "Start climbing" CTA hands
 * logged-in visitors off to this origin via a transfer token; logged-out
 * visitors link straight to it and the app runs its own login.
 *
 * NEXT_PUBLIC_ prefix so the value is inlined into the client bundle for the CTA
 * link. A prod default keeps the CTA pointing at the live app even when the env
 * var is unset.
 */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.boardsesh.com';

/**
 * Server-side origin for the transfer-token hand-off performed by the mint route
 * (`/api/auth/native/callback?redirect=web`). Prefers a server-only `APP_URL`
 * override, then the public value, then the prod default — so a deployment can
 * point the server hand-off somewhere other than the client link if it needs to,
 * without ever falling back to something outside the app origin.
 */
export const SERVER_APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.boardsesh.com';
