import 'server-only';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { webCredentialProofSchema } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';

const PURPOSE = 'boardsesh-provider-security-flow-v1';
const MAX_COOKIE_BYTES = 3800;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.iso.datetime();

/** This sealed command frame contains capabilities, never an actor or proposed
 * credential. Every reader must also prove the exact current browser selection. */
export const providerSecurityFlowSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(['link', 'unlink']),
    provider: z.enum(['google', 'apple']),
    methodId: digest.nullable(),
    actorKind: z.enum(['legacy-jwe', 'canonical-token']),
    actorCredentialHash: digest,
    browserBindingHash: digest,
    browserVersion: z.number().int().nonnegative().max(2_147_483_646),
    browserBindingExpiresAt: timestamp,
    sourceCredentialProof: webCredentialProofSchema,
    credentialExpiresAt: timestamp,
    intentToken: capability,
    browserIntentToken: capability,
    recoveryToken: capability,
    issuedAt: timestamp,
    expiresAt: timestamp,
    reauthenticationToken: capability.nullable(),
    reauthenticationExpiresAt: timestamp.nullable(),
    providerFlowHash: digest.nullable(),
    googleFlowHash: digest.nullable(),
    googleNonce: z.string().min(1).max(1024).nullable(),
  })
  .strict();
export type ProviderSecurityFlow = z.infer<typeof providerSecurityFlowSchema>;

function refuse(): never {
  throw new AuthBackendUnavailableError();
}
function milliseconds(iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return refuse();
  return parsed;
}
function flowKey(secret: string): Buffer {
  if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) return refuse();
  return Buffer.from(hkdfSync('sha256', secret, PURPOSE, 'boardsesh-web-operation-cookie', 32));
}
function bytes(encoded: string): Buffer {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return refuse();
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) return refuse();
  return decoded;
}
function capture(input: unknown, now: Date): ProviderSecurityFlow {
  const flow = providerSecurityFlowSchema.parse(input);
  const clock = now.getTime();
  const issuedAt = milliseconds(flow.issuedAt);
  const expiresAt = milliseconds(flow.expiresAt);
  const sourceExpiry = milliseconds(flow.credentialExpiresAt);
  const bindingExpiry = milliseconds(flow.browserBindingExpiresAt);
  if (
    !Number.isSafeInteger(clock) ||
    clock <= 0 ||
    issuedAt > clock ||
    expiresAt <= clock ||
    expiresAt <= issuedAt ||
    expiresAt > issuedAt + 15 * 60_000 ||
    expiresAt > sourceExpiry ||
    expiresAt > bindingExpiry ||
    (flow.action === 'link' ? flow.methodId !== null : flow.methodId === null) ||
    (flow.reauthenticationToken === null) !== (flow.reauthenticationExpiresAt === null) ||
    (flow.googleFlowHash === null) !== (flow.googleNonce === null)
  )
    return refuse();
  if (flow.sourceCredentialProof.authenticatedAt !== null) {
    if (milliseconds(flow.sourceCredentialProof.authenticatedAt) > issuedAt) return refuse();
  } else if (flow.sourceCredentialProof.linkGuarded) return refuse();
  if (flow.reauthenticationExpiresAt !== null) {
    const proofExpiry = milliseconds(flow.reauthenticationExpiresAt);
    if (proofExpiry <= clock || proofExpiry > expiresAt || flow.reauthenticationToken === null) return refuse();
  }
  return flow;
}

/** Public selector only. Possession of this digest never authorizes a command. */
export function providerSecurityOperationKey(intentToken: string): string {
  return createHash('sha256').update(capability.parse(intentToken)).digest('hex');
}
export function providerSecurityFlowCookieName(operationKey: string, secure: boolean): string {
  const suffix = digest.parse(operationKey);
  return `${secure ? '__Host-' : ''}boardsesh.provider-security.${suffix}`;
}

export async function sealProviderSecurityFlow(input: unknown, secret: string, now = new Date()): Promise<string> {
  try {
    const flow = capture(input, now);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', flowKey(secret), nonce);
    cipher.setAAD(Buffer.from(PURPOSE));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ flow }), 'utf8'), cipher.final()]);
    const sealed = [
      'v1',
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
    if (Buffer.byteLength(sealed) > MAX_COOKIE_BYTES) return refuse();
    return sealed;
  } catch {
    return refuse();
  }
}

export async function openProviderSecurityFlow(
  sealed: string,
  operationKey: string,
  secret: string,
  now = new Date(),
): Promise<ProviderSecurityFlow> {
  try {
    const clock = new Date(now.getTime());
    if (!sealed || Buffer.byteLength(sealed) > MAX_COOKIE_BYTES) return refuse();
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return refuse();
    const nonce = bytes(parts[1]);
    const ciphertext = bytes(parts[2]);
    const tag = bytes(parts[3]);
    if (nonce.length !== 12 || tag.length !== 16) return refuse();
    const decipher = createDecipheriv('aes-256-gcm', flowKey(secret), nonce);
    decipher.setAAD(Buffer.from(PURPOSE));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    const payload = z.object({ flow: providerSecurityFlowSchema }).strict().parse(decoded);
    const flow = capture(payload.flow, clock);
    if (providerSecurityOperationKey(flow.intentToken) !== digest.parse(operationKey)) return refuse();
    return Object.freeze({ ...flow, sourceCredentialProof: Object.freeze({ ...flow.sourceCredentialProof }) });
  } catch {
    return refuse();
  }
}
