import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { parsePartnerSecrets, type PartnerSecret } from '../../auth/partner/configuration';

const CONTEXT = 'boardsesh-partner-webhook-secret-v1';
export const webhookEncryptionKeys = (): PartnerSecret[] => parsePartnerSecrets(process.env.PARTNER_OAUTH_SECRETS);
const encryptionKey = (secret: PartnerSecret) => createHmac('sha256', secret.value).update(CONTEXT).digest();

export function encryptWebhookSecret(secret: string, keys: readonly PartnerSecret[] = webhookEncryptionKeys()): string {
  const key = keys[0];
  if (!key) throw new Error('Webhook encryption key unavailable');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(`wh1.${key.version}`));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `wh1.${key.version}.${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')}`;
}

export function decryptWebhookSecret(sealed: string, keys: readonly PartnerSecret[] = webhookEncryptionKeys()): string {
  const match = /^wh1\.(\d{1,9})\.([A-Za-z0-9_-]+)$/.exec(sealed);
  const key = match && keys.find((candidate) => candidate.version === Number(match[1]));
  if (!match || !key) throw new Error('Webhook encryption key unavailable');
  const bytes = Buffer.from(match[2], 'base64url');
  if (bytes.length < 29) throw new Error('Invalid encrypted webhook secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`wh1.${key.version}`));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
}

export function webhookSignature(rawBody: string, secrets: readonly string[], now = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},${secrets.map((secret) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`).join(',')}`;
}
