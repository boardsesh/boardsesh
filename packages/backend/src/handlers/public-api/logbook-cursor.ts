import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * The `c3.` cursor of `GET /v1/logbook/changes` (docs/integration-platform.md,
 * "Reading it"): its kind, the connection it is bound to and the position, plus
 * the feed generation for a change cursor (a snapshot row carries its own).
 *
 * Encrypted and authenticated with AES-256-GCM under a key derived from the
 * partner OAuth secret of the version the cursor names, so an app can neither
 * read it nor build one: it says nothing about the climber, not even internal
 * ids, and a forged or altered cursor fails authentication. The issue time is
 * there for diagnosis; validity is decided by the feed and snapshot rules.
 *
 * Shape: `c3.<secret version>.<base64url(iv || ciphertext || tag)>`.
 */

export const TEST_EXPIRED_CURSOR = 'c3.expired';
/** Far above any cursor this encodes (about 220 characters), far below anything worth decrypting. */
const MAX_CURSOR_LENGTH = 1024;
/**
 * Nine digits of version: `parsePartnerSecrets` refuses a version above
 * 999,999,999 at startup, so every configured secret fits. The two limits move
 * together; partner-logbook-units.test.ts checks they agree.
 */
const CURSOR_FORMAT = /^c3\.(\d{1,9})\.([A-Za-z0-9_-]+)$/;
const KEY_CONTEXT = 'boardsesh-logbook-cursor-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** One version of the partner OAuth secret (`PARTNER_OAUTH_SECRETS`). */
export interface LogbookCursorSecret {
  version: number;
  value: string;
}

export type LogbookCursor =
  | {
      kind: 'snapshot';
      connectionId: string;
      connectionGeneration: number;
      snapshotId: string;
      position: number;
    }
  | {
      kind: 'changes';
      connectionId: string;
      connectionGeneration: number;
      feedGeneration: string;
      txid: string;
      seq: string;
    };

const DECIMAL = /^\d{1,20}$/;

/** Short keys keep the cursor small. Strict, so nothing else survives a decode. */
const SnapshotPayloadSchema = z.strictObject({
  k: z.literal('s'),
  c: z.string().min(1).max(64),
  g: z.number().int().nonnegative(),
  s: z.uuid(),
  p: z.number().int().nonnegative(),
  t: z.number().int(),
});
const ChangesPayloadSchema = z.strictObject({
  k: z.literal('c'),
  c: z.string().min(1).max(64),
  g: z.number().int().nonnegative(),
  f: z.uuid(),
  x: z.string().regex(DECIMAL),
  q: z.string().regex(DECIMAL),
  t: z.number().int(),
});
const PayloadSchema = z.discriminatedUnion('k', [SnapshotPayloadSchema, ChangesPayloadSchema]);

export type DecodedLogbookCursor =
  | { status: 'ok'; cursor: LogbookCursor }
  /** `c3.expired`, or a version whose secret has been retired: answer 410. */
  | { status: 'expired' }
  /** Not a cursor this API issued: answer 400 `invalid_cursor`. */
  | { status: 'invalid' };

function cursorKey(secret: LogbookCursorSecret): Buffer {
  return createHmac('sha256', secret.value).update(KEY_CONTEXT).digest();
}

function associatedData(version: number): Buffer {
  return Buffer.from(`c3.${version}`, 'utf8');
}

/** Encrypts under the newest secret (the first, as `PARTNER_OAUTH_SECRETS` lists them). */
export function encodeLogbookCursor(
  cursor: LogbookCursor,
  secrets: readonly LogbookCursorSecret[],
  now = Date.now(),
): string {
  const [secret] = secrets;
  if (!secret) throw new Error('No secret to encode a logbook cursor with.');
  const issuedAt = Math.floor(now / 1000);
  const payload =
    cursor.kind === 'snapshot'
      ? {
          k: 's',
          c: cursor.connectionId,
          g: cursor.connectionGeneration,
          s: cursor.snapshotId,
          p: cursor.position,
          t: issuedAt,
        }
      : {
          k: 'c',
          c: cursor.connectionId,
          g: cursor.connectionGeneration,
          f: cursor.feedGeneration,
          x: cursor.txid,
          q: cursor.seq,
          t: issuedAt,
        };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  cipher.setAAD(associatedData(secret.version));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
  return `c3.${secret.version}.${sealed}`;
}

export function decodeLogbookCursor(raw: string, secrets: readonly LogbookCursorSecret[]): DecodedLogbookCursor {
  if (raw === TEST_EXPIRED_CURSOR) return { status: 'expired' };
  if (raw.length > MAX_CURSOR_LENGTH) return { status: 'invalid' };
  const match = CURSOR_FORMAT.exec(raw);
  if (!match) return { status: 'invalid' };
  const version = Number(match[1]);
  const secret = secrets.find((candidate) => candidate.version === version);
  // Issued under a secret that has since been retired, as far as anyone can
  // tell: the app restarts its sync rather than being told it sent junk.
  if (!secret) return { status: 'expired' };

  const sealed = Buffer.from(match[2], 'base64url');
  if (sealed.length <= IV_BYTES + TAG_BYTES) return { status: 'invalid' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), sealed.subarray(0, IV_BYTES));
    decipher.setAAD(associatedData(version));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const payload = PayloadSchema.safeParse(JSON.parse(plaintext));
    if (!payload.success) return { status: 'invalid' };
    const { data } = payload;
    return data.k === 's'
      ? {
          status: 'ok',
          cursor: {
            kind: 'snapshot',
            connectionId: data.c,
            connectionGeneration: data.g,
            snapshotId: data.s,
            position: data.p,
          },
        }
      : {
          status: 'ok',
          cursor: {
            kind: 'changes',
            connectionId: data.c,
            connectionGeneration: data.g,
            feedGeneration: data.f,
            txid: data.x,
            seq: data.q,
          },
        };
  } catch {
    // A failed tag check, or a payload that is not JSON.
    return { status: 'invalid' };
  }
}
