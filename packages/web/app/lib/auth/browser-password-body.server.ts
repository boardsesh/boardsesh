import 'server-only';
import {
  BROWSER_PASSWORD_BROWSER_FORM_FIELDS,
  browserPasswordBrowserPrepareMetadataSchema,
} from '@boardsesh/auth-protocol/browser-password-browser-v1';
import { PublicAuthRequestError } from './public-auth-request.server';

import { readSettledPasswordBody } from './browser-password-body';
export { readSettledPasswordBody } from './browser-password-body';

async function requestText(request: Request, contentType: RegExp): Promise<string> {
  if (!contentType.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding'))
    throw new PublicAuthRequestError(400);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 65_536))
    throw new PublicAuthRequestError(400);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readSettledPasswordBody(request.body, request.signal, 65_536);
  } catch {
    throw new PublicAuthRequestError(400);
  }
  if (declared !== null && Number(declared) !== bytes.byteLength) throw new PublicAuthRequestError(400);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PublicAuthRequestError(400);
  }
}
export async function readBrowserPasswordControl(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await requestText(request, /^application\/json(?:\s*;\s*charset=utf-8)?$/i)) as unknown;
  } catch {
    throw new PublicAuthRequestError(400);
  }
}
export async function readBrowserPasswordForm(request: Request) {
  const form = new URLSearchParams(
    await requestText(request, /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i),
  );
  const allowed = new Set([
    'email',
    'password',
    'csrfToken',
    'callbackUrl',
    'json',
    BROWSER_PASSWORD_BROWSER_FORM_FIELDS.bindingId,
    BROWSER_PASSWORD_BROWSER_FORM_FIELDS.version,
  ]);
  if ([...form.keys()].some((name) => !allowed.has(name) || form.getAll(name).length !== 1))
    throw new PublicAuthRequestError(400);
  const email = form.get('email'),
    password = form.get('password'),
    csrfToken = form.get('csrfToken'),
    callbackUrl = form.get('callbackUrl');
  const revision = form.get(BROWSER_PASSWORD_BROWSER_FORM_FIELDS.version);
  if (
    !email ||
    !password ||
    !csrfToken ||
    csrfToken.length > 1_024 ||
    !callbackUrl ||
    callbackUrl.length > 4_096 ||
    form.get('json') !== 'true' ||
    !revision ||
    !/^(0|[1-9][0-9]*)$/.test(revision)
  )
    throw new PublicAuthRequestError(400);
  const metadata = browserPasswordBrowserPrepareMetadataSchema.parse({
    cursor: {
      bindingId: form.get(BROWSER_PASSWORD_BROWSER_FORM_FIELDS.bindingId),
      version: Number(revision),
    },
  });
  form.delete(BROWSER_PASSWORD_BROWSER_FORM_FIELDS.bindingId);
  form.delete(BROWSER_PASSWORD_BROWSER_FORM_FIELDS.version);
  return Object.freeze({ metadata: Object.freeze(metadata), email, password, callbackUrl, form });
}
