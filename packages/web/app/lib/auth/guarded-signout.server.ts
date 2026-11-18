import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';

export type ExpectedSignOutIdentity = {
  userId: string;
  authSessionId: string;
};

/** The identity fields a guarded sign-out form posts, read without consuming the request body. */
export async function readExpectedSignOutIdentity(
  request: NextRequest,
): Promise<ExpectedSignOutIdentity | null | 'invalid' | 'unavailable'> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    // Couldn't even read the body as form data (too large, wrong content-type,
    // a transient stream error). That's a server-side condition, not a client
    // identity mismatch — surface it as retryable ('unavailable' → 503) so the
    // caller doesn't treat a transient failure as a permanent identity change.
    return 'unavailable';
  }

  const expectedUserId = form.get('expectedUserId');
  const expectedAuthSessionId = form.get('expectedAuthSessionId');
  if (expectedUserId === null && expectedAuthSessionId === null) return null;
  if (
    typeof expectedUserId !== 'string' ||
    !expectedUserId.trim() ||
    typeof expectedAuthSessionId !== 'string' ||
    !expectedAuthSessionId.trim()
  ) {
    return 'invalid';
  }
  return { userId: expectedUserId.trim(), authSessionId: expectedAuthSessionId.trim() };
}

export function guardedSignOutResponse(status: number, error: string): NextResponse {
  return NextResponse.json(
    { error },
    {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
