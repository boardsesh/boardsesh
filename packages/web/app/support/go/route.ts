import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import {
  CREATE_SUPPORT_CLAIM,
  type CreateSupportClaimResponse,
  type CreateSupportClaimVariables,
} from '@boardsesh/graphql/operations/support';
import { authOptions } from '@/app/lib/auth/auth-options';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { compactErrorMessage } from '@/app/lib/observability/compact-error';
import { createRequestLogger, type RequestLogger } from '@/app/lib/observability/request-logger';
import {
  readSupportLinksConfig,
  resolveSupportLinkKey,
  sanitizeSupportSrc,
  withSupportClaim,
  withSupportSource,
  type ResolvedSupportLink,
} from '../support-links';

// Per visitor and per click: never cached, never prerendered.
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
} as const;

/**
 * A click is waiting on this, so a slow backend costs at most this long before
 * the visitor goes to Stripe without a claim (the payment is then anonymous,
 * and claim by email can still link it later).
 */
const SUPPORT_CLAIM_TIMEOUT_MS = 3000;

function redirectTo(location: string): NextResponse {
  // A plain 302 with a Location header: a relative `/support` stays on the
  // host the visitor is on, wherever the proxy in front of this server is.
  return new NextResponse(null, { status: 302, headers: { Location: location, ...NO_STORE_HEADERS } });
}

/**
 * The Payment Link tagged with a fresh claim for the signed-in account, or
 * null when the visitor is signed out or anything about the claim fails.
 */
async function claimedDestination(link: ResolvedSupportLink, src: string, log: RequestLogger): Promise<string | null> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return null;
    const authToken = await getServerAuthToken();
    if (!authToken) return null;
    const response = await executeAuthenticatedGraphQL<CreateSupportClaimResponse, CreateSupportClaimVariables>(
      CREATE_SUPPORT_CLAIM,
      { cadence: link.cadence === 'monthly' ? 'monthly' : 'one_time', currency: link.currency, src },
      authToken,
      AbortSignal.timeout(SUPPORT_CLAIM_TIMEOUT_MS),
    );
    return withSupportClaim(link.url, { claimId: response.createSupportClaim, src, email: session.user.email });
  } catch (error) {
    log.warn('support claim failed; sending the visitor on without one', { error: compactErrorMessage(error) });
    return null;
  }
}

/**
 * `/support/go?link=<key>&src=<src>`: every Stripe button on `/support` comes
 * through here.
 *
 * - The key names one configured Payment Link (`resolveSupportLinkKey`). A key
 *   the env does not have goes back to `/support`, so this route can only ever
 *   redirect to a link the env listed.
 * - Signed in: a `createSupportClaim` id goes in `client_reference_id` and the
 *   account email in `prefilled_email`, so the webhook links the payment.
 * - Signed out, or the claim failed: the link tagged with `src`, exactly as
 *   the buttons pointed before this route existed.
 *
 * It is a GET because it is a link. A forged one can at most make a signed-in
 * visitor's account hold an unused claim, which the backend rate-limits and
 * prunes after 30 days.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const src = sanitizeSupportSrc(searchParams.get('src') ?? undefined);
  const link = resolveSupportLinkKey(readSupportLinksConfig(), searchParams.get('link'));
  if (!link) return redirectTo(`/support?${new URLSearchParams({ src }).toString()}`);
  const log = createRequestLogger(request, { route: '/support/go' });
  const destination = (await claimedDestination(link, src, log)) ?? withSupportSource(link.url, src);
  return redirectTo(destination);
}
