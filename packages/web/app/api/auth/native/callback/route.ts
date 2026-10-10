import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import {
  issueNativeOAuthTransferToken,
  NATIVE_OAUTH_ATTEMPT_COOKIE,
  verifyNativeOAuthAttempt,
} from '@/app/lib/auth/native-oauth-transfer';
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

const deepLinkRedirect = (url: string) => {
  const response = new NextResponse(
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
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  );
  response.cookies.set(NATIVE_OAUTH_ATTEMPT_COOKIE, '', {
    path: '/api/auth/native',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
  });
  return response;
};

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_missing`);
  }

  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  const attempt = verifyNativeOAuthAttempt(request.cookies.get(NATIVE_OAUTH_ATTEMPT_COOKIE)?.value);
  const proof = session.nativeOAuthCreationProof;
  const verifiedProof =
    attempt &&
    attempt.attemptId === request.nextUrl.searchParams.get('attemptId') &&
    attempt.provider === request.nextUrl.searchParams.get('provider') &&
    proof?.provider === attempt.provider &&
    proof.authSessionId === session.authSessionId &&
    proof.accountCreation.userId === session.user.id &&
    proof.signedInAt > attempt.startedAt &&
    proof.signedInAt <= Date.now()
      ? {
          accountCreation: proof.accountCreation,
          authSessionId: proof.authSessionId,
          provider: proof.provider,
          attemptId: attempt.attemptId,
        }
      : {};
  let transferToken: string;
  try {
    transferToken = issueNativeOAuthTransferToken({
      userId: session.user.id,
      nextPath,
      ...verifiedProof,
    });
  } catch {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=token_issue_failed`);
  }

  const redirectUrl = `${NATIVE_OAUTH_CALLBACK_SCHEME}?transferToken=${encodeURIComponent(transferToken)}&next=${encodeURIComponent(nextPath)}`;
  return deepLinkRedirect(redirectUrl);
}
