import 'server-only';
import { createHash } from 'node:crypto';
import {
  browserBindingMode,
  type BrowserBindingReply,
  type BrowserSelectionPossession,
  type BrowserSourceCredential,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import {
  createBrowserBindingCommandClient,
  type BrowserBindingCommandClient,
} from './browser-binding-command-client.server';
import { readBrowserCorrelationCookie, readBrowserProofCookie } from './browser-proof-cookies.server';

type AdmittedReply = Extract<BrowserBindingReply, { operation: 'read'; outcome: 'admitted' }>;
type Cursor = AdmittedReply['cursor'];
export interface AdmittedBrowserSelection {
  readonly status: 'admitted';
  readonly bindingToken: string;
  readonly actor: Readonly<{ version: number; credential: Readonly<BrowserSourceCredential> }>;
  readonly cursor: Readonly<Cursor>;
  readonly session: Readonly<AdmittedReply['session']>;
  readonly user: Readonly<AdmittedReply['user']>;
}
export type PresentedBrowserSelection =
  | AdmittedBrowserSelection
  | { readonly status: 'anonymous'; readonly cursor: Readonly<Cursor> }
  | { readonly status: 'missing-binding' | 'proof-required' | 'denied' | 'conflict' | 'unavailable' };

/** Server-only source possession. No public adapter may serialize this envelope.
 * A missing/refused current proof never selects a legacy or higher cookie. */
export async function readPresentedBrowserSelection(
  cookieHeader: string | null,
  options: { readonly client?: BrowserBindingCommandClient; readonly environment?: AuthServiceEnvironment } = {},
): Promise<PresentedBrowserSelection> {
  try {
    const environment = options.environment ?? process.env;
    if (browserBindingMode(environment) !== 'backend-staging') return { status: 'unavailable' };
    const correlation = readBrowserCorrelationCookie(cookieHeader);
    if (correlation.status === 'missing') return { status: 'missing-binding' };
    if (correlation.status !== 'present') return { status: 'denied' };
    const client = options.client ?? createBrowserBindingCommandClient({ environment });
    const descriptor = await client.describe({ bindingToken: correlation.token });
    if (descriptor.outcome !== 'known') return { status: descriptor.outcome };
    if (descriptor.cursor.bindingId !== correlation.bindingId) return { status: 'unavailable' };
    let actor: BrowserSelectionPossession | undefined;
    if (descriptor.state === 'selected') {
      // The private cursor has an expiry field. The codec deliberately accepts
      // only its two-field public control cursor, never the unprojected object.
      const selected = readBrowserProofCookie(cookieHeader, {
        bindingId: descriptor.cursor.bindingId,
        version: descriptor.cursor.version,
      });
      if (selected.status === 'missing') return { status: 'proof-required' };
      if (selected.status !== 'present' || selected.proof.kind !== descriptor.credentialKind)
        return { status: 'denied' };
      const credential: BrowserSourceCredential =
        selected.proof.kind === 'canonical-token'
          ? { kind: 'canonical-token', token: selected.proof.rawCredential }
          : { kind: 'legacy-jwe', credential: selected.proof.rawCredential };
      actor = { version: descriptor.cursor.version, credential };
    }
    const admitted = await client.read({ bindingToken: correlation.token, ...(actor ? { actor } : {}) });
    if (admitted.outcome === 'admitted' || admitted.outcome === 'anonymous') {
      if (
        admitted.cursor.bindingId !== descriptor.cursor.bindingId ||
        admitted.cursor.version !== descriptor.cursor.version
      )
        return { status: 'conflict' };
      if (admitted.outcome === 'anonymous')
        return descriptor.state === 'anonymous'
          ? Object.freeze({ status: 'anonymous', cursor: Object.freeze({ ...admitted.cursor }) })
          : { status: 'conflict' };
      if (!actor || descriptor.state !== 'selected' || admitted.user.id !== admitted.session.userId)
        return { status: 'unavailable' };
      const deadline = Math.min(Date.parse(admitted.session.expiresAt), Date.parse(admitted.cursor.bindingExpiresAt));
      if (!Number.isFinite(deadline)) return { status: 'unavailable' };
      if (deadline <= Date.now()) return { status: 'denied' };
      return Object.freeze({
        status: 'admitted',
        bindingToken: correlation.token,
        actor: Object.freeze({ version: actor.version, credential: Object.freeze({ ...actor.credential }) }),
        cursor: Object.freeze({ ...admitted.cursor }),
        session: Object.freeze({ ...admitted.session }),
        user: Object.freeze({ ...admitted.user }),
      });
    }
    if (admitted.outcome === 'denied' || admitted.outcome === 'conflict') return { status: admitted.outcome };
    return { status: 'unavailable' };
  } catch {
    // An outage or invalid private reply is never an authenticated profile or
    // a confirmed logout. Keep source material and transport causes private.
    return { status: 'unavailable' };
  }
}

/** UI cancellation metadata only; never an authentication assertion. */
export function browserActorContextKey(selection: AdmittedBrowserSelection): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'browser-actor-context-v1',
        selection.cursor.bindingId,
        selection.cursor.version,
        selection.session.userId,
        selection.session.authSessionId,
        selection.session.generation,
      ]),
    )
    .digest('hex');
}
