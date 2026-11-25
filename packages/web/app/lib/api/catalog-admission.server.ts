import 'server-only';
import { NextResponse } from 'next/server';
import {
  CATALOG_ADMISSION_PATH,
  CATALOG_PROOF_HEADER,
  signCatalogRequest,
} from '@boardsesh/crypto/catalog-request-proof';
import { CATALOG_SNAPSHOT_MANIFEST_URL } from '@boardsesh/shared-schema/catalog-access-policy';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { trustedClientRateLimitKey } from '@/app/lib/auth/trusted-client-ip.server';

type RestCatalogOperation = 'restclimb' | 'reststats' | 'restsetters';
type AdmissionFailure = { error: string; code: string; retryAfterSeconds: number; snapshotManifestUrl: string };
const ADMISSION_TIMEOUT_MS = 3000;

function refusal(status: 429 | 503, retryAfter = 1): NextResponse<AdmissionFailure> {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfter));
  return NextResponse.json(
    {
      error:
        status === 429
          ? 'Catalog request budget exceeded. Use the daily snapshots for bulk downloads.'
          : 'Catalog access is temporarily unavailable. The daily snapshots remain available.',
      code: status === 429 ? 'RATE_LIMITED' : 'CATALOG_ADMISSION_UNAVAILABLE',
      retryAfterSeconds,
      snapshotManifestUrl: CATALOG_SNAPSHOT_MANIFEST_URL,
    },
    {
      status,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
      },
    },
  );
}

/** Reserve before any database work, and keep the lease through response construction. */
export async function withCatalogAdmission<T>(
  request: Request,
  operation: RestCatalogOperation,
  work: (recordRows: (actualRows: number) => void) => Promise<NextResponse<T>>,
): Promise<NextResponse<T | AdmissionFailure>> {
  const secret = process.env.NEXTAUTH_SECRET;
  const baseUrl = getBackendHttpUrl();
  if (!secret || !baseUrl) return refusal(503);
  const endpoint = new URL(CATALOG_ADMISSION_PATH, baseUrl).toString();
  const clientIp = trustedClientRateLimitKey(request);
  const command = async (action: 'reserve' | 'release', fields: Record<string, unknown>) => {
    const body = JSON.stringify({ action, ...fields });
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CATALOG_PROOF_HEADER]: signCatalogRequest(
          { purpose: action, method: 'POST', pathname: CATALOG_ADMISSION_PATH, clientIp, body },
          secret,
        ),
      },
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
    });
  };

  let lease: unknown;
  try {
    const response = await command('reserve', { operation });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      return refusal(response.status === 429 ? 429 : 503, Number.isFinite(retryAfter) ? retryAfter : 1);
    }
    const reservation: unknown = await response.json();
    if (
      typeof reservation !== 'object' ||
      reservation === null ||
      !('lease' in reservation) ||
      typeof reservation.lease !== 'object' ||
      reservation.lease === null ||
      !('id' in reservation.lease) ||
      typeof reservation.lease.id !== 'string' ||
      reservation.lease.id.length === 0
    )
      return refusal(503);
    lease = reservation.lease;
  } catch {
    // Never log the request options: the server proof contains visitor attribution.
    return refusal(503);
  }

  let actualRows: number | null = null;
  try {
    return await work((count) => {
      if (Number.isSafeInteger(count) && count >= 0) actualRows = count;
    });
  } finally {
    try {
      // A failed read keeps its full row reservation. Redis lease expiry bounds
      // concurrency if this release cannot reach the backend.
      await command('release', { lease, actualRows });
    } catch {
      // A completed catalog response must not become a failure on release loss.
    }
  }
}
