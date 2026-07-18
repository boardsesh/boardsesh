import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import { issueNativeOAuthTransferToken } from '@/app/lib/auth/native-oauth-transfer';
import { NATIVE_OAUTH_CALLBACK_SCHEME } from '@/app/lib/auth/native-oauth-config';

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

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_missing`);
  }

  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  let transferToken: string;
  try {
    transferToken = issueNativeOAuthTransferToken({
      userId: session.user.id,
      nextPath,
    });
  } catch {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=token_issue_failed`);
  }

  const redirectUrl = `${NATIVE_OAUTH_CALLBACK_SCHEME}?transferToken=${encodeURIComponent(transferToken)}&next=${encodeURIComponent(nextPath)}`;
  return deepLinkRedirect(redirectUrl);
}
