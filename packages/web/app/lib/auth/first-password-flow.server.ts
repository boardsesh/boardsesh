import 'server-only';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { webCredentialProofSchema } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';

const purpose = 'boardsesh-first-password-browser-flow-v1';
const maximumCookieBytes = 3800;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.iso.datetime();
const firstPasswordFlowSchema = z
  .object({
    version: z.literal(1),
    actorKind: z.enum(['legacy-jwe', 'canonical-token']),
    actorCredentialHash: digest,
    sourceCredentialProof: webCredentialProofSchema,
    credentialExpiresAt: timestamp,
    browserBindingHash: digest,
    browserVersion: z.number().int().nonnegative().max(2_147_483_646),
    browserBindingExpiresAt: timestamp,
    challengeToken: capability,
    browserIntentToken: capability,
    recoveryToken: capability,
    preparationToken: capability.nullable(),
    candidateCredentialHash: digest.nullable(),
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict();
export type FirstPasswordFlow = z.infer<typeof firstPasswordFlowSchema>;

function refuse(): never {
  throw new AuthBackendUnavailableError();
}
function key(secret: string): Buffer {
  if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) return refuse();
  return Buffer.from(hkdfSync('sha256', secret, purpose, 'boardsesh-web-operation-cookie', 32));
}
export function assertFirstPasswordFlowSecret(secret: string): void {
  key(secret);
}
export function firstPasswordOperationKey(challengeToken: string): string {
  return createHash('sha256').update(capability.parse(challengeToken)).digest('hex');
}
export function firstPasswordFlowCookieName(operationKey: string): string {
  return `__Host-boardsesh.first-password.${digest.parse(operationKey)}`;
}
function capture(input: unknown, now: Date): FirstPasswordFlow {
  const flow = firstPasswordFlowSchema.parse(input);
  const clock = now.getTime();
  const issuedAt = Date.parse(flow.issuedAt);
  const expiresAt = Date.parse(flow.expiresAt);
  if (
    !Number.isSafeInteger(clock) ||
    clock <= 0 ||
    issuedAt > clock ||
    expiresAt <= clock ||
    expiresAt <= issuedAt ||
    expiresAt > issuedAt + 5 * 60_000 ||
    expiresAt > Date.parse(flow.credentialExpiresAt) ||
    expiresAt > Date.parse(flow.browserBindingExpiresAt) ||
    (flow.preparationToken === null) !== (flow.candidateCredentialHash === null) ||
    (flow.sourceCredentialProof.authenticatedAt === null
      ? flow.sourceCredentialProof.linkGuarded
      : Date.parse(flow.sourceCredentialProof.authenticatedAt) > issuedAt)
  )
    return refuse();
  return flow;
}
function bytes(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return refuse();
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) return refuse();
  return decoded;
}

/** Contains only bounded metadata and command capabilities. The confirmation,
 * password, actual source and candidate are never stored in this cookie. */
export function sealFirstPasswordFlow(input: unknown, secret: string, now = new Date()): string {
  try {
    const flow = capture(input, now);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(flow), 'utf8'), cipher.final()]);
    const sealed = [
      'v1',
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
    if (Buffer.byteLength(sealed) > maximumCookieBytes) return refuse();
    return sealed;
  } catch {
    return refuse();
  }
}
export function openFirstPasswordFlow(
  sealed: string,
  operationKey: string,
  secret: string,
  now = new Date(),
): Readonly<FirstPasswordFlow> {
  try {
    if (Buffer.byteLength(sealed) > maximumCookieBytes) return refuse();
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return refuse();
    const nonce = bytes(parts[1]);
    const ciphertext = bytes(parts[2]);
    const tag = bytes(parts[3]);
    if (nonce.length !== 12 || tag.length !== 16) return refuse();
    const decipher = createDecipheriv('aes-256-gcm', key(secret), nonce);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const flow = capture(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown, now);
    if (firstPasswordOperationKey(flow.challengeToken) !== digest.parse(operationKey)) return refuse();
    return Object.freeze({ ...flow, sourceCredentialProof: Object.freeze({ ...flow.sourceCredentialProof }) });
  } catch {
    return refuse();
  }
}
