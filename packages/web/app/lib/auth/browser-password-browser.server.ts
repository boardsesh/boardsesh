import 'server-only';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { NextAuthOptions } from 'next-auth';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { browserPasswordMode, type BrowserPasswordReply } from '@boardsesh/auth-protocol/browser-password-v1';
import {
  BROWSER_PASSWORD_BROWSER_PATHS,
  browserPasswordBrowserControlSchema,
  browserPasswordBrowserRecoverySchema,
} from '@boardsesh/auth-protocol/browser-password-browser-v1';
import { type AuthServiceEnvironment, AuthBackendUnavailableError } from './auth-command-transport.server';
import { createBrowserPasswordAuthPreparation } from './browser-password-auth.server';
import { readBrowserPasswordControl, readBrowserPasswordForm } from './browser-password-body.server';
import {
  browserPasswordCandidateHash,
  createBrowserPasswordCommandClient,
  type BrowserPasswordCommandClient,
} from './browser-password-command-client.server';
import {
  browserPasswordCustodySchema,
  sealBrowserPasswordCustody,
  openBrowserPasswordCustody,
  buildBrowserPasswordCustodyCookies,
  buildObservedBrowserPasswordCustodyClears,
  observedBrowserPasswordOperationKeys,
  readBrowserPasswordCustody,
  type BrowserPasswordCustody,
} from './browser-password-custody.server';
import {
  passwordBrowserResponse,
  preparePasswordTargetResponse,
  preparePasswordConfirmationResponse,
} from './browser-password-publication.server';
import {
  captureBrowserPasswordSource,
  requirePreparedPasswordSource,
  passwordTargetMatches,
} from './browser-password-selection.server';
import { publicBrowserPasswordReady } from './browser-password-readiness';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readBrowserCorrelationCookie } from './browser-proof-cookies.server';
import { boundedAuthCookiePairs, PublicAuthRequestError, requirePublicAuthRequest } from './public-auth-request.server';
import { admitPasswordLogin } from './password-command-auth.server';

type Operation = keyof typeof BROWSER_PASSWORD_BROWSER_PATHS;
type Custody = Readonly<BrowserPasswordCustody>;
const unavailable = (): never => {
  throw new AuthBackendUnavailableError();
};
const cursor = (current: { bindingId: string; version: number }) => ({
  bindingId: current.bindingId,
  version: current.version,
});
const sameCursor = (left: { bindingId: string; version: number }, right: { bindingId: string; version: number }) =>
  left.bindingId === right.bindingId && left.version === right.version;
const commandPayload = (custody: Custody) => ({
  source: custody.source,
  operationToken: custody.operationToken,
  browserIntentToken: custody.browserIntentToken,
  preparation: custody.preparation,
  candidate: custody.candidate,
});

/** Canonical utility facade. Only encrypted first-response custody supplies
 * capabilities; public cursors and operation keys never supply possession. */
export function createBrowserPasswordHandler(
  operation: Operation,
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly client?: BrowserPasswordCommandClient;
    readonly readSelection?: (header: string | null) => Promise<PresentedBrowserSelection>;
    readonly authOptions?: () => NextAuthOptions | Promise<NextAuthOptions>;
    readonly prepareAuth?: typeof createBrowserPasswordAuthPreparation;
    readonly admission?: typeof admitPasswordLogin;
    readonly operationKey?: () => string;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? (() => publicBrowserPasswordReady() && publicBrowserCoordinatorReady());
  const readSelection = options.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
  const prepareAuth = options.prepareAuth ?? createBrowserPasswordAuthPreparation;
  return async (request: Request): Promise<Response> => {
    let preparedAbort: (() => Promise<void>) | undefined;
    let finalizationStarted = false;
    const header = request.headers.get('cookie');
    try {
      const origin = requirePublicAuthRequest(request, BROWSER_PASSWORD_BROWSER_PATHS[operation], 'POST', environment);
      boundedAuthCookiePairs(header);
      if (
        !ready() ||
        browserBindingMode(environment) !== 'backend-staging' ||
        browserPasswordMode(environment) !== 'backend-staging' ||
        request.signal.aborted
      )
        return unavailable();
      const secret = environment.NEXTAUTH_SECRET;
      if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) return unavailable();
      const client = options.client ?? createBrowserPasswordCommandClient({ environment });
      const check = (custody?: Custody, preparation = false) => {
        const now = Date.now();
        if (
          request.signal.aborted ||
          !Number.isSafeInteger(now) ||
          now <= 0 ||
          (custody &&
            now >=
              Math.min(
                Date.parse(custody.preparation.acknowledgeUntil),
                Date.parse(custody.preparation.credentialExpiresAt),
                preparation ? Date.parse(custody.preparation.expiresAt) : Infinity,
              ))
        )
          return unavailable();
      };
      const physicalBinding = (custody: Custody) => {
        const binding = readBrowserCorrelationCookie(header);
        if (
          binding.status !== 'present' ||
          binding.token !== custody.source.bindingToken ||
          binding.bindingId !== custody.preparation.browserCursor.bindingId
        )
          return unavailable();
      };
      const acknowledge = async (custody: Custody) => {
        check(custody);
        const reply = await client.acknowledge(commandPayload(custody));
        check(custody);
        return reply;
      };
      const exactCompleted = (reply: BrowserPasswordReply, custody: Custody) => {
        if (
          reply.outcome !== 'completed' ||
          !sameCursor(reply.cursor, custody.preparation.futureBrowserCursor) ||
          reply.cursor.bindingExpiresAt !== custody.preparation.futureBrowserCursor.bindingExpiresAt ||
          reply.candidateCredentialHash !== browserPasswordCandidateHash(custody.candidate) ||
          reply.credentialExpiresAt !== custody.preparation.credentialExpiresAt ||
          JSON.stringify(reply.credentialProof) !== JSON.stringify(custody.preparation.credentialProof)
        )
          return unavailable();
      };
      if (operation === 'prepare') {
        // Reserve before any installed-framework or password work. Refund only
        // from authorize after the actual backend comparison accepts.
        const admission = (options.admission ?? admitPasswordLogin)(request);
        if (admission.limitedResponse) {
          const response = passwordBrowserResponse({ status: 'rate-limited' }, 503, [], header);
          const retry = admission.limitedResponse.headers.get('retry-after');
          if (retry) response.headers.set('Retry-After', retry);
          return response;
        }
        const form = await readBrowserPasswordForm(request);
        const source = captureBrowserPasswordSource(header, await readSelection(header));
        if (!sameCursor(source.cursor, form.metadata.cursor)) return unavailable();
        const operationKey = (options.operationKey ?? (() => randomBytes(32).toString('hex')))();
        const frameworkHeaders = new Headers(request.headers);
        frameworkHeaders.delete('content-length');
        frameworkHeaders.set('content-type', 'application/x-www-form-urlencoded');
        const frameworkRequest = new NextRequest(`${origin}/api/auth/callback/credentials`, {
          method: 'POST',
          headers: frameworkHeaders,
          body: form.form,
          signal: request.signal,
        });
        const base = options.authOptions ? await options.authOptions() : (await import('./auth-options')).authOptions;
        const preparation = prepareAuth(
          base,
          frameworkRequest,
          {
            source,
            operationKey,
            canonicalOrigin: origin,
            email: form.email,
            password: form.password,
            credentialKind:
              source.source.state === 'selected' ? source.source.actor.credential.kind : 'canonical-token',
          },
          { client, environment, passwordAccepted: admission.passwordAccepted, readSelection },
        );
        preparedAbort = preparation.abort;
        const result = await preparation.run();
        check();
        if (result.status === 'framework-result')
          return passwordBrowserResponse(
            { status: 'framework-result', result: { url: result.destination, status: result.responseStatus } },
            200,
            [],
            header,
          );
        const custody = browserPasswordCustodySchema.parse({
          version: 1,
          purpose: 'boardsesh-browser-password-candidate-custody-v1',
          operationKey,
          canonicalOrigin: origin,
          source: source.source,
          operationToken: result.prepared.operationToken,
          browserIntentToken: result.prepared.browserIntentToken,
          preparation: result.prepared.preparation,
          candidate: result.candidate,
          destination: result.destination,
        });
        const sealed = sealBrowserPasswordCustody(custody, secret);
        const response = passwordBrowserResponse(
          {
            status: 'prepared',
            operationKey,
            sourceCursor: cursor(custody.preparation.browserCursor),
            targetCursor: cursor(custody.preparation.futureBrowserCursor),
          },
          200,
          buildBrowserPasswordCustodyCookies(custody, sealed, header),
          header,
        );
        check(custody, true);
        return response;
      }
      const body = await readBrowserPasswordControl(request);
      if (operation === 'acknowledge') {
        browserPasswordBrowserRecoverySchema.parse(body);
        // Deliberately before ANY source read/preflight. A durable completion
        // can coexist with a live selected binding whose cookie response died.
        const clears: string[] = [];
        for (const operationKey of observedBrowserPasswordOperationKeys(header)) {
          const sealed = readBrowserPasswordCustody(header, operationKey);
          if (!sealed) return unavailable();
          const opening = openBrowserPasswordCustody(sealed, operationKey, origin, secret);
          const custody = opening.custody;
          physicalBinding(custody);
          if (opening.status === 'expired') {
            clears.push(...buildObservedBrowserPasswordCustodyClears(header, operationKey));
            continue;
          }
          const reply = await acknowledge(custody);
          // Pending/newer receipts cannot block a different exact completed op.
          if (reply.outcome === 'conflict' || reply.outcome === 'denied') continue;
          exactCompleted(reply, custody);
          const target = preparePasswordTargetResponse(custody, header, 'recovered');
          if (!passwordTargetMatches(await readSelection(target.projectedCookieHeader), custody)) return unavailable();
          check(custody);
          exactCompleted(await acknowledge(custody), custody);
          return target.response;
        }
        check();
        return passwordBrowserResponse({ status: 'none' }, 200, clears, header);
      }
      const control = browserPasswordBrowserControlSchema.parse(body);
      const sealed = readBrowserPasswordCustody(header, control.operationKey);
      if (!sealed) return unavailable();
      const opening = openBrowserPasswordCustody(sealed, control.operationKey, origin, secret);
      if (opening.status !== 'live') return unavailable();
      const custody = opening.custody;
      physicalBinding(custody);
      if (operation === 'commit') {
        check(custody, true);
        if (!sameCursor(control.cursor, custody.preparation.browserCursor)) return unavailable();
        const source = captureBrowserPasswordSource(header, await readSelection(header));
        requirePreparedPasswordSource(custody.preparation, source);
        if (JSON.stringify(source.source) !== JSON.stringify(custody.source)) return unavailable();
        // Body, every cookie/header and capacity are frozen before the one RPC.
        const target = preparePasswordTargetResponse(custody, header);
        check(custody, true);
        finalizationStarted = true;
        exactCompleted(await client.finalize(commandPayload(custody)), custody);
        if (!passwordTargetMatches(await readSelection(target.projectedCookieHeader), custody)) return unavailable();
        check(custody);
        exactCompleted(await acknowledge(custody), custody);
        return target.response;
      }
      if (!sameCursor(control.cursor, custody.preparation.futureBrowserCursor)) return unavailable();
      if (!passwordTargetMatches(await readSelection(header), custody)) return unavailable();
      const response = preparePasswordConfirmationResponse(custody, header);
      check(custody);
      exactCompleted(await acknowledge(custody), custody);
      return response;
    } catch (error) {
      if (!finalizationStarted) await preparedAbort?.().catch(() => undefined);
      const status = error instanceof PublicAuthRequestError ? error.status : 503;
      // No input, custody, credential, decoder or transport causes escape.
      return new Response(JSON.stringify({ status: status === 503 ? 'unavailable' : 'denied' }), {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'private, no-store',
          'X-Robots-Tag': 'noindex, follow',
        },
      });
    }
  };
}
