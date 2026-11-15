import { z } from 'zod';
import type { SignInResponse } from 'next-auth/react';
import {
  BROWSER_COORDINATOR_LOCK,
  BROWSER_COORDINATOR_PUBLIC_PATHS,
  browserBindingCursorSchema,
  browserCoordinatorObservationSchema,
  type BrowserBindingCursor,
} from '@boardsesh/auth-protocol/browser-coordinator';
import {
  BROWSER_PASSWORD_BROWSER_PATHS,
  BROWSER_PASSWORD_BROWSER_FORM_FIELDS,
  browserPasswordBrowserReplySchema,
  type BrowserPasswordBrowserReply,
} from '@boardsesh/auth-protocol/browser-password-browser-v1';
import { readSettledPasswordBody } from './browser-password-body';

export const canonicalPasswordOptionsSchema = z
  .object({
    email: z.string().min(1),
    password: z.string().min(1),
    callbackUrl: z.string().max(4096).optional(),
    redirect: z.boolean().optional(),
  })
  .strict();
interface PasswordLocks {
  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    invoke: () => Promise<void>,
  ): Promise<void>;
}
const unavailable = (): never => {
  throw new Error('PASSWORD_SIGNIN_UNAVAILABLE');
};
const sameCursor = (left: BrowserBindingCursor, right: BrowserBindingCursor) =>
  left.bindingId === right.bindingId && left.version === right.version;

/** Canonical physical network custody. No password, cookie or capability is
 * placed in a coordinator port. Every body AND cancellation settles in lock. */
export async function signInCanonicalPassword(
  input: {
    readonly canonicalOrigin: string;
    readonly email: string;
    readonly password: string;
    readonly callbackUrl: string;
    readonly redirect: boolean;
    readonly signal: AbortSignal;
  },
  dependencies: {
    readonly currentOrigin: string;
    readonly locks: PasswordLocks | undefined;
    readonly preflight: (origin: string, signal: AbortSignal) => Promise<BrowserBindingCursor | void>;
    readonly send: typeof fetch;
    readonly navigate: (url: string) => void;
  },
): Promise<SignInResponse | undefined> {
  const { canonicalOrigin, signal } = input;
  const origin = new URL(canonicalOrigin),
    callback = new URL(input.callbackUrl, canonicalOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== canonicalOrigin ||
    dependencies.currentOrigin !== canonicalOrigin ||
    !dependencies.locks ||
    signal.aborted ||
    !input.email ||
    !input.password ||
    input.callbackUrl.length > 4096 ||
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.hash
  )
    return unavailable();
  const requestLock = dependencies.locks.request.bind(dependencies.locks),
    send = dependencies.send;
  const physical = async (path: string, init: RequestInit = {}) => {
    if (signal.aborted) return unavailable();
    const response = await send(canonicalOrigin + path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: false,
      redirect: 'error',
      signal,
    });
    const bytes = await readSettledPasswordBody(response.body, signal, 16_384);
    if (signal.aborted || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
      return unavailable();
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { response, body };
  };
  const command = async (path: string, body: unknown): Promise<BrowserPasswordBrowserReply> => {
    const physicalReply = await physical(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reply = browserPasswordBrowserReplySchema.parse(physicalReply.body);
    if (physicalReply.response.status !== 200 || signal.aborted) return unavailable();
    return reply;
  };
  let destination: string | undefined;
  let frameworkStatus = 200;
  const confirm = async (operationKey: string, target: BrowserBindingCursor) => {
    const reply = await command(BROWSER_PASSWORD_BROWSER_PATHS.confirm, { operationKey, cursor: target });
    if (reply.status !== 'confirmed' || reply.operationKey !== operationKey || !sameCursor(reply.cursor, target))
      return unavailable();
    destination = reply.url;
  };
  // FIRST action: exact ACK-only recovery. A durable lost-response selection
  // would otherwise make ordinary preflight reject its now-missing proof.
  await requestLock(BROWSER_COORDINATOR_LOCK, { mode: 'exclusive', signal }, async () => {
    const recovery = await command(BROWSER_PASSWORD_BROWSER_PATHS.acknowledge, { purpose: 'password-signin-recovery' });
    if (recovery.status === 'recovered') await confirm(recovery.operationKey, recovery.cursor);
    else if (recovery.status !== 'none') return unavailable();
  });
  if (!destination) {
    // The frame takes this same lock. Release before its metadata-only preflight.
    const pinned = browserBindingCursorSchema.parse(await dependencies.preflight(canonicalOrigin, signal));
    if (signal.aborted) return unavailable();
    await requestLock(BROWSER_COORDINATOR_LOCK, { mode: 'exclusive', signal }, async () => {
      const observed = await physical(BROWSER_COORDINATOR_PUBLIC_PATHS.observe);
      const current = browserCoordinatorObservationSchema.parse(observed.body);
      if (observed.response.status !== 200 || current.status !== 'ready' || !sameCursor(current.cursor, pinned))
        return unavailable();
      const csrf = await physical('/api/auth/csrf');
      const token = z
        .object({ csrfToken: z.string().min(1).max(1024) })
        .strict()
        .parse(csrf.body);
      if (csrf.response.status !== 200 || signal.aborted) return unavailable();
      const form = new URLSearchParams({
        email: input.email,
        password: input.password,
        callbackUrl: callback.href,
        csrfToken: token.csrfToken,
        json: 'true',
        [BROWSER_PASSWORD_BROWSER_FORM_FIELDS.bindingId]: pinned.bindingId,
        [BROWSER_PASSWORD_BROWSER_FORM_FIELDS.version]: String(pinned.version),
      });
      if (new TextEncoder().encode(form.toString()).byteLength > 65_536) return unavailable();
      const preparation = await physical(BROWSER_PASSWORD_BROWSER_PATHS.prepare, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const prepared = browserPasswordBrowserReplySchema.parse(preparation.body);
      if (preparation.response.status !== 200) return unavailable();
      if (prepared.status === 'framework-result') {
        destination = prepared.result.url;
        frameworkStatus = prepared.result.status;
        return;
      }
      if (prepared.status !== 'prepared' || !sameCursor(prepared.sourceCursor, pinned)) return unavailable();
      const completed = await command(BROWSER_PASSWORD_BROWSER_PATHS.commit, {
        operationKey: prepared.operationKey,
        cursor: pinned,
      });
      if (
        completed.status !== 'committed' ||
        completed.operationKey !== prepared.operationKey ||
        !sameCursor(completed.cursor, prepared.targetCursor)
      )
        return unavailable();
      await confirm(prepared.operationKey, prepared.targetCursor);
    });
  }
  if (!destination || signal.aborted) return unavailable();
  const finished = new URL(destination);
  if (finished.protocol !== 'https:' || finished.username || finished.password || finished.hash) return unavailable();
  if (input.redirect) {
    dependencies.navigate(destination);
    return undefined;
  }
  const error = finished.searchParams.get('error');
  return {
    error,
    status: frameworkStatus,
    ok: frameworkStatus >= 200 && frameworkStatus < 300,
    url: error ? null : finished.href,
  };
}
