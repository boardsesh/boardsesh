import { eq } from 'drizzle-orm';
import { authCredentialLineage, authSession } from '@boardsesh/db/schema/auth';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { decideCredential, type SubjectCutoffState } from '../credential-cutoffs';
import { readHumanSubjectState } from '../human-admission';
import type { AuthorityDatabase } from './adapter';

export interface FirstPartySession {
  readonly userId: string;
  readonly authSessionId: string;
  readonly generation: number;
  readonly authenticatedAt: Date | null;
  readonly expiresAt: Date;
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
        authenticatedAt: proof.linkGuarded ? proof.originalAuthenticatedAt : null,
        expiresAt: proof.expiresAt,
      };
    } else {
      if (!credential.token || credential.token.length > 4096) return { status: 'denied' };
      const [canonical] = await database.select().from(authSession).where(eq(authSession.token, credential.token));
      if (!canonical || canonical.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
      if (canonical.legacyLineageId) {
        const [lineage] = await database
          .select()
          .from(authCredentialLineage)
          .where(eq(authCredentialLineage.id, canonical.legacyLineageId));
        if (lineage && (lineage.revokedAt || lineage.userId !== canonical.userId || lineage.sessionId !== canonical.id))
          return { status: 'denied' };
      }
      session = {
        userId: canonical.userId,
        authSessionId: canonical.id,
        generation: canonical.revocationGeneration ?? 0,
        // createdAt may be an epoch sentinel; it never proves authentication.
        authenticatedAt: canonical.originalAuthenticatedAt,
        expiresAt: canonical.expiresAt,
      };
    }
    const decision = decideCredential(
      {
        kind: 'web-session',
        generationClaim: session.generation,
        sessionKeyClaim: session.authSessionId,
        authTimeClaim: session.authenticatedAt ? session.authenticatedAt.getTime() / 1000 : null,
      },
      await readSubject(session.userId),
      now.getTime(),
    );
    return decision.denial === null ? { status: 'admitted', session } : { status: 'denied' };
  } catch {
    // Adapter errors can contain query parameters. No exception details escape.
    return { status: 'unavailable' };
  }
}

/** Bridging/renewal does not establish age. Only a recorded sign-in proof does. */
export function requireFreshAuthentication(session: FirstPartySession, now = new Date(), maxAgeSeconds = 300): boolean {
  const authenticatedAt = session.authenticatedAt?.getTime();
  return (
    authenticatedAt !== undefined &&
    authenticatedAt > 0 &&
    authenticatedAt <= now.getTime() &&
    now.getTime() - authenticatedAt <= maxAgeSeconds * 1000
  );
}
