import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ProviderSecurityActor, ProviderSecurityProvider, ProviderSecurityReply } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import type {
  ProviderSecurityCommandClient,
  ProviderSecurityRefusalReply,
} from './provider-security-command-client.server';
import { newRoundTrip, type ProviderFlowRecord } from './provider-flow-cookie.server';
import { authorizationUrl, providerClient, type VerifiedProviderIdentity } from './provider-oidc.server';
import type { authOptions } from './auth-options';

/**
 * The steps of a provider link or unlink after its intent exists (#7596
 * B5e1). Each returns what the route answers; none writes a cookie, the
 * route reseals or clears the flow cookie from the result.
 */

/**
 * The `flowHash` bound to a link intent: from the state the callback carried
 * (its query, or Apple's posted form), never from the sealed copy, under a
 * domain tag no sign-in flow uses (`web-oauth-google-nonce-v1` is the sign-in's).
 */
export function linkFlowHash(provider: ProviderSecurityProvider, state: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['web-oauth-provider-link-state-v1', provider, state]))
    .digest('hex');
}

/** The `flowHash` of a Google reauthentication round trip, under its own domain tag. */
export function reauthenticationFlowHash(state: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['web-oauth-google-reauthentication-state-v1', state]))
    .digest('hex');
}

/** The backend binds `sha256(nonce)` (hex) for a Google reauthentication. */
export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export function sameSecret(expected: string, presented: string | null | undefined): boolean {
  if (typeof presented !== 'string') return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The redirect back to www for one provider's round trips. Registered with Google and Apple by the owner. */
export function providerSecurityCallbackUrl(publicOrigin: string, provider: ProviderSecurityProvider): string {
  return `${publicOrigin}/api/auth/provider-security/callback/${provider}`;
}

export type StepResult =
  /** The account changed: a link or an unlink committed (or was recovered). The flow is over. */
  | { kind: 'committed'; generation: number }
  /** Send the browser to the provider; the record now holds the round trip. */
  | { kind: 'redirect'; url: string; record: ProviderFlowRecord }
  /** The backend refused. `keep` when the climber can try this step again (a wrong password). */
  | { kind: 'refused'; reply: ProviderSecurityRefusalReply; keep: boolean }
  /** Nothing is known (lost reply, 503, a provider that answered nothing usable). */
  | { kind: 'unavailable' };

/** A reply that is not the step's success, as a step result. */
export function refusedStep(reply: ProviderSecurityReply): StepResult {
  if (!('code' in reply)) return { kind: 'unavailable' };
  // A wrong password, or an expired proof: the intent still waits for a reauthentication.
  return { kind: 'refused', reply, keep: reply.outcome === 'reauthentication_required' && reply.code !== 'expired' };
}

/**
 * Finalize, and on a lost reply ask `recover` once with the same session: the
 * session kept its token, so `recovered` says the link or unlink committed.
 */
export async function finalizeWithRecovery(
  client: ProviderSecurityCommandClient,
  actor: ProviderSecurityActor,
  record: ProviderFlowRecord,
  reauthenticationToken: string,
  preparationToken: string,
): Promise<StepResult> {
  let reply: ProviderSecurityReply;
  try {
    reply = await client.send('finalize', {
      actor,
      intentToken: record.intentToken,
      reauthenticationToken,
      preparationToken,
    });
  } catch {
    return recoverLostReply(client, actor, record, reauthenticationToken);
  }
  if (reply.outcome === 'committed') return { kind: 'committed', generation: reply.generation };
  return refusedStep(reply);
}

export async function recoverLostReply(
  client: ProviderSecurityCommandClient,
  actor: ProviderSecurityActor,
  record: ProviderFlowRecord,
  reauthenticationToken: string,
): Promise<StepResult> {
  try {
    const recovered = await client.send('recover', {
      actor,
      intentToken: record.intentToken,
      recoveryToken: record.recoveryToken,
      reauthenticationToken,
    });
    if (recovered.outcome === 'recovered') return { kind: 'committed', generation: recovered.generation };
    return refusedStep(recovered);
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * After a reauthentication proved: an unlink prepares and finalizes now; a
 * link binds a fresh provider round trip to the intent and sends the browser
 * to the provider to choose the account to connect.
 */
export async function continueAfterReauthentication(
  client: ProviderSecurityCommandClient,
  options: typeof authOptions,
  actor: ProviderSecurityActor,
  record: ProviderFlowRecord,
  publicOrigin: string,
): Promise<StepResult> {
  const reauthenticationToken = record.reauthenticationToken;
  if (!reauthenticationToken) return { kind: 'unavailable' };
  try {
    if (record.action === 'unlink') {
      const prepared = await client.send('prepare', {
        actor,
        intentToken: record.intentToken,
        reauthenticationToken,
        flowHash: null,
        providerProof: null,
      });
      if (prepared.outcome !== 'prepared') return refusedStep(prepared);
      return finalizeWithRecovery(client, actor, record, reauthenticationToken, prepared.preparationToken);
    }
    const provider = providerClient(options, record.provider);
    if (!provider) return { kind: 'unavailable' };
    const providerLeg = newRoundTrip();
    const bound = await client.send('bind', {
      actor,
      intentToken: record.intentToken,
      flowHash: linkFlowHash(record.provider, providerLeg.state),
    });
    if (bound.outcome !== 'bound') return refusedStep(bound);
    const url = await authorizationUrl(
      provider,
      providerLeg,
      providerSecurityCallbackUrl(publicOrigin, record.provider),
      'link',
    );
    return { kind: 'redirect', url, record: { ...record, providerLeg, reauthentication: undefined } };
  } catch (error) {
    if (error instanceof AuthBackendUnavailableError) return { kind: 'unavailable' };
    throw error;
  }
}

/**
 * The link's provider answered: prepare with the verified identity and the
 * flow hash of the state the callback carried, then finalize.
 */
export async function finishLink(
  client: ProviderSecurityCommandClient,
  actor: ProviderSecurityActor,
  record: ProviderFlowRecord,
  callbackState: string,
  identity: VerifiedProviderIdentity,
): Promise<StepResult> {
  const reauthenticationToken = record.reauthenticationToken;
  if (!reauthenticationToken) return { kind: 'unavailable' };
  let prepared: ProviderSecurityReply;
  try {
    prepared = await client.send('prepare', {
      actor,
      intentToken: record.intentToken,
      reauthenticationToken,
      flowHash: linkFlowHash(record.provider, callbackState),
      providerProof: {
        provider: record.provider,
        subject: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified,
      },
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (prepared.outcome !== 'prepared') return refusedStep(prepared);
  return finalizeWithRecovery(client, actor, record, reauthenticationToken, prepared.preparationToken);
}

/**
 * Ends the intent, best effort, so a failed round trip gives its slot back
 * (one session holds at most five live intents). A refusal or a lost reply
 * changes nothing here: the intent then ends on its own within 15 minutes.
 */
export async function abortQuietly(
  client: ProviderSecurityCommandClient,
  actor: ProviderSecurityActor,
  intentToken: string,
): Promise<void> {
  await client.send('abort', { actor, intentToken, preparationToken: null, flowHash: null }).catch(() => undefined);
}
