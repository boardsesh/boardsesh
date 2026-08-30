import { schnorr } from '@noble/curves/secp256k1.js';
import {
  runQuantumSyncOnce,
  type NostrEvent,
  type QuantumSyncEnvironment,
  type QuantumSyncOnceResult,
} from '@boardsesh/quantum-sync';
import { db, type Database } from '../db/client';
import {
  importValidatedQuantumSnapshot,
  type QuantumCatalogImportResult,
  type QuantumCatalogBatchRunner,
} from './quantum-catalog-import';

export type QuantumCatalogSyncOptions = Readonly<{
  database?: Database;
  transaction?: QuantumCatalogBatchRunner;
  environment?: QuantumSyncEnvironment;
  signal?: AbortSignal;
  now?: () => Date;
  log?: (message: string) => void;
}>;

/** Fail-closed BIP-340 verifier for authenticated Nostr manifest events. */
export async function verifyQuantumManifestSignature(event: Readonly<NostrEvent>): Promise<boolean> {
  try {
    const signature = strictHexBytes(event.sig, 64);
    const eventId = strictHexBytes(event.id, 32);
    const signerPublicKey = strictHexBytes(event.pubkey, 32);
    return schnorr.verify(signature, eventId, signerPublicKey);
  } catch {
    return false;
  }
}

export async function syncQuantumCatalogOnce(
  options: QuantumCatalogSyncOptions = {},
): Promise<QuantumSyncOnceResult<QuantumCatalogImportResult>> {
  const database = options.database ?? db;
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const transactionRunner: QuantumCatalogBatchRunner = options.transaction ?? ((run) => database.transaction(run));

  const result = await runQuantumSyncOnce(
    {
      verifyEventSignature: verifyQuantumManifestSignature,
      importSnapshot: (snapshot, signal) =>
        importValidatedQuantumSnapshot(snapshot, signal, {
          database,
          now,
          transaction: transactionRunner,
        }),
    },
    { environment, now, signal: options.signal },
  );
  options.log?.(
    result.importResult.outcome === 'unchanged'
      ? `[QuantumSync] event ${result.snapshot.eventId} is already applied`
      : `[QuantumSync] imported event ${result.snapshot.eventId}: ` +
          `${result.importResult.climbsUpserted} climbs, ${result.importResult.holdsUpserted} holds`,
  );
  return result;
}

function strictHexBytes(hex: string, expectedBytes: number): Uint8Array {
  if (hex.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Expected ${expectedBytes} bytes of lowercase hexadecimal data.`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
