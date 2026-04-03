import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/auth/auth-options';
import { issueNativeOAuthTransferToken } from '@/app/lib/auth/native-oauth-transfer';

const NATIVE_CALLBACK_SCHEME = 'com.boardsesh.app://auth/callback';

const sanitizeNextPath = (nextPath: string | null): string =>
  nextPath && nextPath.startsWith('/') ? nextPath : '/';

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.redirect(`${NATIVE_CALLBACK_SCHEME}?error=session_missing`);
  }

  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  let transferToken: string;
  try {
    transferToken = issueNativeOAuthTransferToken({
      userId: session.user.id,
      nextPath,
    });
  } catch {
    return NextResponse.redirect(`${NATIVE_CALLBACK_SCHEME}?error=token_issue_failed`);
  }

  const redirectUrl = `${NATIVE_CALLBACK_SCHEME}?transferToken=${encodeURIComponent(transferToken)}&next=${encodeURIComponent(nextPath)}`;
  return NextResponse.redirect(redirectUrl);
}
