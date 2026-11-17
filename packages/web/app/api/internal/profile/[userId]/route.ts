import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { unavailableCredentialResponse } from '@/app/lib/auth/credential-admission-response.server';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { requireExpectedViewer } from '@/app/lib/auth/expected-viewer.server';
import { type NextRequest, NextResponse } from 'next/server';
import { getProfileData } from '@/app/profile/[user_id]/server-profile-data';

type RouteParams = {
  params: Promise<{ userId: string }>;
};

// What a profile shows depends on who reads it. The published OpenAPI document
// lists this GET for anonymous callers, so a request without the
// expected-viewer header is still answered; one that names another account
// than the cookie gets 409 before the profile is read.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await getAdmittedServerSession();
    const viewerChanged = requireExpectedViewer(request, session, {
      route: '/api/internal/profile/[userId]',
      missing: 'allow',
    });
    if (viewerChanged) return viewerChanged;
    const viewerUserId = session?.user?.id;

    const profileData = await getProfileData(userId, viewerUserId);

    if (!profileData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(profileData);
  } catch (error) {
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    console.error('Failed to get profile:', error);
    return NextResponse.json({ error: 'Failed to get profile' }, { status: 500 });
  }
}
