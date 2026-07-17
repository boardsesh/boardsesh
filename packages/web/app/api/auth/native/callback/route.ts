import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import { issueNativeOAuthTransferToken } from '@/app/lib/auth/native-oauth-transfer';
import { NATIVE_OAUTH_CALLBACK_SCHEME } from '@/app/lib/auth/native-oauth-config';
import { SERVER_APP_URL } from '@/app/lib/app-origin';

const sanitizeNextPath = (nextPath: string | null): string => (nextPath && nextPath.startsWith('/') ? nextPath : '/');

/**
 * Redirect to a custom URL scheme using an HTML page with JavaScript.
 *
 * iOS SFSafariViewController (used by Capacitor's Browser plugin) does not
 * reliably follow HTTP 302 redirects to custom URL schemes — it shows
 * "Safari cannot open the page because the URL is invalid."
 *
 * An HTML page that triggers the redirect via JavaScript + meta refresh
 * works consistently across iOS and Android.
 */
const escapeHtmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const deepLinkRedirect = (url: string) =>
  new Response(
    `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;url=${escapeHtmlAttr(url)}">
</head>
<body>
<script>window.location.href=${JSON.stringify(url)};</script>
</body>
</html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );

/**
 * Build the Expo-web hand-off URL: `${APP_URL}/auth/callback?transferToken&next`.
 *
 * The origin is always `SERVER_APP_URL` (never anything derived from the
 * request), so this can't be an open redirect — `next` rides as a query
 * parameter that the app reads and re-sanitizes, not as the redirect target. The
 * origin assertion guards against a misconfigured `APP_URL` env and documents
 * the invariant.
 */
function buildWebCallbackUrl(transferToken: string, nextPath: string): URL {
  const callbackUrl = new URL('/auth/callback', SERVER_APP_URL);
  if (callbackUrl.origin !== new URL(SERVER_APP_URL).origin) {
    throw new Error('Expo-web callback origin does not match the configured app origin');
  }
  callbackUrl.searchParams.set('transferToken', transferToken);
  callbackUrl.searchParams.set('next', nextPath);
  return callbackUrl;
}

export async function GET(request: NextRequest) {
  // `?redirect=web` (or `?target=web`) hands off to the Expo-web app at
  // app.boardsesh.com with a plain https 307 instead of the native custom-scheme
  // deep link. The meta-refresh HTML shim is only needed for custom schemes.
  const targetParam = request.nextUrl.searchParams.get('redirect') ?? request.nextUrl.searchParams.get('target');
  const targetIsWeb = targetParam === 'web';

  const session = await getServerSession(authOptions);
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get('next'));

  if (!session?.user?.id) {
    // No session: send web callers to the app root (it runs its own login);
    // native callers still get the custom-scheme error the app already handles.
    if (targetIsWeb) {
      return NextResponse.redirect(new URL('/', SERVER_APP_URL), 307);
    }
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_missing`);
  }

  let transferToken: string;
  try {
    transferToken = issueNativeOAuthTransferToken({
      userId: session.user.id,
      nextPath,
    });
  } catch {
    if (targetIsWeb) {
      return NextResponse.redirect(new URL('/', SERVER_APP_URL), 307);
    }
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=token_issue_failed`);
  }

  if (targetIsWeb) {
    return NextResponse.redirect(buildWebCallbackUrl(transferToken, nextPath), 307);
  }

  const redirectUrl = `${NATIVE_OAUTH_CALLBACK_SCHEME}?transferToken=${encodeURIComponent(transferToken)}&next=${encodeURIComponent(nextPath)}`;
  return deepLinkRedirect(redirectUrl);
}
