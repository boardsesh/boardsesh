import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { unavailableCredentialResponse } from '@/app/lib/auth/credential-admission-response.server';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { requireExpectedViewer } from '@/app/lib/auth/expected-viewer.server';
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';

// GET only. The PUT that used to live here had zero callers anywhere in the
// repo — `/settings` reads this route and writes through GraphQL
// `Mutation.updateProfile` — and it was never in the published OpenAPI
// document either, so no third party could have been told it existed. What
// the document DID advertise on this path was a POST the route has never
// exported (#4662).
//
// The published OpenAPI document lists this GET for any session holder, so a
// request without the expected-viewer header is still answered. One that names
// another account than the cookie gets 409 before anything is read.

export async function GET(request: NextRequest) {
  try {
    const session = await getAdmittedServerSession();
    const viewerChanged = requireExpectedViewer(request, session, { route: '/api/internal/profile', missing: 'allow' });
    if (viewerChanged) return viewerChanged;

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getDb();

    // Run all queries in parallel since they are independent
    const [profiles, users, credentials, linkedAccounts] = await Promise.all([
      db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, session.user.id)).limit(1),
      db.select().from(schema.users).where(eq(schema.users.id, session.user.id)).limit(1),
      db
        .select({ userId: schema.userCredentials.userId })
        .from(schema.userCredentials)
        .where(eq(schema.userCredentials.userId, session.user.id))
        .limit(1),
      db
        .select({ provider: schema.accounts.provider })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, session.user.id)),
    ]);

    if (users.length === 0) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const user = users[0];
    const profile = profiles.length > 0 ? profiles[0] : null;

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      hasPassword: credentials.length > 0,
      linkedProviders: linkedAccounts.map((a) => a.provider),
      profile: profile
        ? {
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            instagramUrl: profile.instagramUrl,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    console.error('Failed to get profile:', error);
    return NextResponse.json({ error: 'Failed to get profile' }, { status: 500 });
  }
}
