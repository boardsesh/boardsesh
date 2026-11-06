import 'server-only';
import { NextResponse } from 'next/server';

export const CREDENTIAL_AUTHORITY_HEADER = 'X-Boardsesh-Credential-Authority';

/** A fixed retryable result with no credential-bearing cause or cookie changes. */
export function unavailableCredentialResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Credential authority is temporarily unavailable' },
    {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store', [CREDENTIAL_AUTHORITY_HEADER]: 'unavailable' },
    },
  );
}
