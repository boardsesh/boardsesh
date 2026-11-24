import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DbInstance } from '@boardsesh/db/client';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import {
  createNativeOAuthTransferCodec,
  NATIVE_TRANSFER_PROTOCOL_VERSION,
  type NativeTransferCommand,
  type NativeTransferReply,
} from '@boardsesh/auth-protocol/native-oauth-transfer';
import { captureIdentityAuthority, revalidateIdentityAuthority } from '../authority/router';
import { captureExpectedAuthority, lockSubjectRow, type ExpectedCurrentStoreAuthority } from './foundation-context';
import { assertFresh, boundSignInLockWaits, transactionSettings } from './command-context';

const codec = createNativeOAuthTransferCodec({
  encode: (text) => Buffer.from(text).toString('base64url'),
  decode: (encoded) => Buffer.from(encoded, 'base64url').toString('utf8'),
  hmac: (text, secret) => createHmac('sha256', secret).update(text).digest('base64url'),
  equal: (actual, expected) => {
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  },
  hash: (text) => createHash('sha256').update(text).digest('hex'),
});
export function readBrowserNativeTransfer(token: string, secret: string) {
  return codec.readNativeOAuthTransfer(token, secret, Date.now());
}
class TransferExpired extends Error {}

/**
 * Claims the browser's existing single-use transfer, not a native exchange or a
 * fresh authentication. Old web callers and this command insert the same marker.
 * Lost committed replies are terminal; no compensating delete or automatic retry.
 */
export async function claimBrowserNativeTransfer(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
  command: NativeTransferCommand,
  secret: string,
): Promise<NativeTransferReply> {
  const authority = captureExpectedAuthority(authorityInput);
  const {
    requestId,
    issuedAt,
    payload: { transferToken },
  } = command;
  const metadata = {
    nativeTransferProtocolVersion: NATIVE_TRANSFER_PROTOCOL_VERSION,
    operation: 'claim' as const,
    requestId,
  } as const;
  assertFresh(issuedAt);
  if (!codec.readNativeOAuthTransfer(transferToken, secret, Date.now())) return { ...metadata, outcome: 'denied' };
  try {
    return await database.transaction(async (transaction): Promise<NativeTransferReply> => {
      await transactionSettings(transaction);
      const receipt = await captureIdentityAuthority(transaction, authority);
      await boundSignInLockWaits(transaction);
      const decoded = codec.readNativeOAuthTransfer(transferToken, secret, Date.now());
      if (!decoded) throw new TransferExpired();
      const user = await lockSubjectRow(transaction, decoded.userId);
      if (!user) return { ...metadata, outcome: 'denied' };
      // A held authority gate/user row must not extend the signed capability.
      if (!codec.readNativeOAuthTransfer(transferToken, secret, Date.now())) throw new TransferExpired();
      assertFresh(issuedAt);
      const marker = codec.nativeOAuthTransferSpentMarker(transferToken, secret);
      if (!marker) throw new TransferExpired();
      const claimed = await transaction
        .insert(verificationTokens)
        .values(marker)
        .onConflictDoNothing()
        .returning({ token: verificationTokens.token });
      if (claimed.length !== 1) return { ...metadata, outcome: 'denied' };
      await revalidateIdentityAuthority(transaction, receipt);
      if (!codec.readNativeOAuthTransfer(transferToken, secret, Date.now())) throw new TransferExpired();
      assertFresh(issuedAt);
      return {
        ...metadata,
        outcome: 'claimed',
        user: { id: user.id, email: user.email, name: user.name, image: user.image },
        // These are the signed source fields. Never read/stamp a new generation,
        // SID or authentication time for a transfer of an existing login.
        sourceGeneration: decoded.generation,
        ...(decoded.credentialProof ? { credentialProof: decoded.credentialProof } : {}),
      };
    });
  } catch (error) {
    if (error instanceof TransferExpired) return { ...metadata, outcome: 'denied' };
    throw error;
  }
}
