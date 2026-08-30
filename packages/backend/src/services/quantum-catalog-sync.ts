import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  resolveQuantumSyncContract,
  runQuantumSyncDaemon,
  runQuantumSyncOnce,
  QuantumSyncError,
  type NostrEvent,
  type QuantumDaemonOptions,
  type QuantumSyncEnvironment,
  type QuantumSyncOnceResult,
} from '@boardsesh/quantum-sync';
import { DaemonLease } from '@boardsesh/sync-runtime';
import { acquireOrRenewDaemonLease, releaseDaemonLease, QUANTUM_SYNC_DAEMON } from '@boardsesh/db/queries';
import { db, type Database } from '../db/client';
import {
  importValidatedQuantumSnapshot,
  recordQuantumCatalogSyncAttempt,
  recordQuantumCatalogSyncFailure,
  type QuantumCatalogImportResult,
} from './quantum-catalog-import';

export type QuantumCatalogSyncOptions = Readonly<{
  database?: Database;
  environment?: QuantumSyncEnvironment;
  signal?: AbortSignal;
  now?: () => Date;
  log?: (message: string) => void;
}>;

export type QuantumCatalogDaemonOptions = QuantumCatalogSyncOptions &
  Readonly<{
    daemon?: QuantumDaemonOptions;
    leaseHolderId?: string;
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
  const contract = resolveQuantumSyncContract({}, environment);
  await recordQuantumCatalogSyncAttempt(database, contract.source, now());

  try {
    const result = await runQuantumSyncOnce(
      {
        verifyEventSignature: verifyQuantumManifestSignature,
        importSnapshot: (snapshot, signal) =>
          importValidatedQuantumSnapshot(snapshot, signal, {
            database,
            now,
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
  } catch (error) {
    try {
      const diagnosticError =
        error instanceof QuantumSyncError && error.code === 'IMPORT_FAILED' && error.cause !== undefined
          ? error.cause
          : error;
      await recordQuantumCatalogSyncFailure(database, contract.source, diagnosticError, now());
    } catch {
      // Acquisition/import failures remain authoritative even if checkpointing
      // the diagnostic row also fails during a database outage.
    }
    throw error;
  }
}

/** Run once immediately, then every six hours, with the standard daemon lease. */
export async function runQuantumCatalogDaemon(options: QuantumCatalogDaemonOptions = {}): Promise<void> {
  const database = options.database ?? db;
  const log = options.log ?? (() => {});
  const leaseHolderId = options.leaseHolderId ?? randomUUID();
  const lease = new DaemonLease(
    QUANTUM_SYNC_DAEMON,
    {
      acquireOrRenew: () =>
        acquireOrRenewDaemonLease(database, {
          daemonName: QUANTUM_SYNC_DAEMON,
          holderId: leaseHolderId,
          hostname: hostname(),
        }),
      release: () =>
        releaseDaemonLease(database, {
          daemonName: QUANTUM_SYNC_DAEMON,
          holderId: leaseHolderId,
        }),
    },
    {
      onLog: log,
      onError: (error) => log(`[QuantumSync] lease error: ${errorMessage(error)}`),
    },
  );

  try {
    await runQuantumSyncDaemon(
      async () => {
        await syncQuantumCatalogOnce(options);
        lease.assertStillHeld();
      },
      options.daemon,
      {
        signal: options.signal,
        acquireSlot: lease.acquire,
        onLog: log,
        onCycleError: (error) => log(`[QuantumSync] daemon cycle failed: ${errorMessage(error)}`),
      },
    );
  } finally {
    await lease.stop();
  }
}

function strictHexBytes(hex: string, expectedBytes: number): Uint8Array {
  if (hex.length !== expectedBytes * 2 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Expected ${expectedBytes} bytes of lowercase hexadecimal data.`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
