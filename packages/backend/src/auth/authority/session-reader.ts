import { eq } from 'drizzle-orm';
import type { WebSignInProof } from '@boardsesh/shared-schema';
import { authCredentialLineage, authSession } from '@boardsesh/db/schema/auth';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { decideCredential, type SubjectCutoffState } from '../credential-cutoffs';
import { readHumanSubjectState } from '../human-admission';
import type { AuthorityDatabase } from './adapter';
import { sessionTokenDigest } from './session-token';

/**
 * Where a session's sign-in time came from (#7596, owner decision 3).
 * `login`: a sign-in this system verified, so its time may count as fresh.
 * `bridge`: carried over from an older credential (a legacy web cookie or a
 * native refresh row), so its time serves the 30-day rules and never a
 * five-minute one.
 */
export type FirstPartySessionSource = 'login' | 'bridge';

export interface FirstPartySession {
  readonly userId: string;
  readonly authSessionId: string;
  readonly generation: number;
  readonly requiresAccountCutoff: boolean;
  readonly authenticatedAt: Date | null;
  readonly linkGuarded: boolean;
  readonly expiresAt: Date;
  /**
   * Set by `readFirstPartySession`. Absent means unknown, which never counts as
   * fresh. A canonical row is `bridge` exactly when it has a legacy lineage;
   * no column stores it.
   */
  readonly source?: FirstPartySessionSource;
  /**
   * The legacy lineage the session belongs to: a legacy cookie's own, or a
   * canonical row's `legacy_lineage_id`. Lets a caller find the one row the
   * bridge made from a cookie without a session id (exact id and lineage).
   */
  readonly lineageId?: string | null;
}
export type FirstPartySessionResult =
  | { readonly status: 'admitted'; readonly session: FirstPartySession }
  | { readonly status: 'denied' }
  | { readonly status: 'unavailable' };

export type FirstPartyCredential =
  | { readonly kind: 'legacy-jwe'; readonly credential: string; readonly secret: string }
  // Only the canonical opaque session token, after transport cookie signature
  // validation. Never accept a public session ID as an authentication token.
  | { readonly kind: 'canonical-token'; readonly token: string };

/**
 * The row rules every canonical session read applies, whatever found the row
 * (the cookie's token digest, or a browser access token's session id): the row
 * is unexpired, and its legacy lineage, when that row exists, is unrevoked and
 * still names this account and this row. Undefined means not live.
 */
export function canonicalFirstPartySession(
  canonical: typeof authSession.$inferSelect | undefined,
  lineage: typeof authCredentialLineage.$inferSelect | undefined,
  now: Date,
): FirstPartySession | undefined {
  if (!canonical || canonical.expiresAt.getTime() <= now.getTime()) return undefined;
  if (canonical.legacyLineageId && lineage?.id === canonical.legacyLineageId) {
    if (lineage.revokedAt || lineage.userId !== canonical.userId || lineage.sessionId !== canonical.id)
      return undefined;
  }
  return {
    userId: canonical.userId,
    authSessionId: canonical.id,
    generation: canonical.revocationGeneration ?? 0,
    requiresAccountCutoff: canonical.legacyLineageId?.startsWith('credential:') ?? false,
    // createdAt may be an epoch sentinel; it never proves authentication.
    authenticatedAt: canonical.originalAuthenticatedAt,
    linkGuarded: canonical.originalAuthenticatedAt !== null,
    expiresAt: canonical.expiresAt,
    // Rows without a lineage come from sign-ins this system verified
    // (`issueWebSession`, the staged provider sign-ins). The bridge and
    // the native refresh binding always record one, and a `carried`
    // web session records a `carried:` id that names no lineage row.
    source: canonical.legacyLineageId === null ? 'login' : 'bridge',
    lineageId: canonical.legacyLineageId,
  };
}

/**
 * The account rules: the account exists and is not deleted, the session's
 * generation is the account's, and its id has no denial. Strict: no `observe`.
 */
export function admitsFirstPartySession(
  session: FirstPartySession,
  subject: SubjectCutoffState | undefined,
  now: Date,
): boolean {
  return (
    decideCredential(
      {
        kind: 'web-session',
        generationClaim: session.generation,
        sessionKeyClaim: session.authSessionId,
        authTimeClaim: session.authenticatedAt ? session.authenticatedAt.getTime() / 1000 : null,
      },
      subject,
      now.getTime(),
    ).denial === null
  );
}

/** No positive cache. Crypto refusal differs from primary/database unavailability. */
export async function readFirstPartySession(
  database: Pick<AuthorityDatabase, 'select'>,
  credential: FirstPartyCredential,
  now = new Date(),
  readSubject: (userId: string) => Promise<SubjectCutoffState | undefined> = readHumanSubjectState,
): Promise<FirstPartySessionResult> {
  try {
    let session: FirstPartySession;
    if (credential.kind === 'legacy-jwe') {
      const proof = await verifyLegacyNextAuthJwe(credential.credential, credential.secret, now);
      if (!proof) return { status: 'denied' };
      session = {
        userId: proof.userId,
        authSessionId: proof.authSessionId ?? proof.lineageId,
        generation: proof.generation,
        requiresAccountCutoff: proof.requiresAccountCutoff,
        authenticatedAt: proof.linkGuarded ? proof.originalAuthenticatedAt : null,
        linkGuarded: proof.linkGuarded,
        expiresAt: proof.expiresAt,
        // Read directly, a NextAuth cookie is the legacy login itself. Once
        // bridged, its canonical row reads as `bridge` below.
        source: 'login',
        lineageId: proof.lineageId,
      };
    } else {
      if (!credential.token || credential.token.length > 4096) return { status: 'denied' };
      // Rows store only the token's digest; a stored digest presented as a token never matches.
      const [canonical] = await database
        .select()
        .from(authSession)
        .where(eq(authSession.token, sessionTokenDigest(credential.token)));
      if (!canonical || canonical.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
      const [lineage] = canonical.legacyLineageId
        ? await database
            .select()
            .from(authCredentialLineage)
            .where(eq(authCredentialLineage.id, canonical.legacyLineageId))
        : [];
      const admitted = canonicalFirstPartySession(canonical, lineage, now);
      if (!admitted) return { status: 'denied' };
      session = admitted;
    }
    return admitsFirstPartySession(session, await readSubject(session.userId), now)
      ? { status: 'admitted', session }
      : { status: 'denied' };
  } catch {
    // Adapter errors can contain query parameters. No exception details escape.
    return { status: 'unavailable' };
  }
}

/**
 * Bridging/renewal does not establish age. Only a recorded sign-in proof does,
 * and only from a `login`: a bridged session keeps its legacy sign-in time for
 * the 30-day rules but never passes a five-minute check.
 */
export function requireFreshAuthentication(session: FirstPartySession, now = new Date(), maxAgeSeconds = 300): boolean {
  const authenticatedAt = session.authenticatedAt?.getTime();
  return (
    session.source === 'login' &&
    session.linkGuarded === true &&
    authenticatedAt !== undefined &&
    authenticatedAt > 0 &&
    authenticatedAt <= now.getTime() &&
    now.getTime() - authenticatedAt <= maxAgeSeconds * 1000
  );
}

/**
 * The `ConnectionContext.webSignIn` a request authenticated by this session may
 * carry. That value feeds only five-minute checks (partner app changes), so a
 * session that is not a `login` proves no sign-in time there. The 30-day
 * partner-consent rule reads `session.authenticatedAt` itself, whatever the source.
 */
export function webSignInProof(session: FirstPartySession): WebSignInProof {
  return {
    authenticatedAtMs: session.source === 'login' ? (session.authenticatedAt?.getTime() ?? null) : null,
    linkGuarded: session.linkGuarded,
  };
}
