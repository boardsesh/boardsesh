import { QUANTUM_MANIFEST_KIND } from './constants';
import { resolveQuantumSyncContract, type QuantumSyncConfigOverrides, type QuantumSyncEnvironment } from './config';
import { downloadQuantumChunk } from './download';
import { QuantumSyncError } from './errors';
import { selectLatestQuantumManifest } from './nostr';
import { createNostrEventLoader } from './relay';
import {
  validateQuantumSqliteFile,
  type OpenQuantumSqlite,
  type QuantumSqliteAggregateLimits,
  type QuantumSqliteRowLimits,
} from './sqlite';
import type {
  ImportValidatedQuantumSnapshot,
  LoadNostrEvents,
  QuantumMirrorFetch,
  QuantumHostnameResolver,
  QuantumSyncOnceResult,
  ValidatedQuantumSnapshot,
  VerifyNostrEventSignature,
  ZstdStreamDecoder,
} from './types';
import { decompressQuantumSnapshot } from './zstd';

export type QuantumSyncDependencies<Result> = {
  verifyEventSignature: VerifyNostrEventSignature;
  importSnapshot: ImportValidatedQuantumSnapshot<Result>;
  loadEvents?: LoadNostrEvents;
  fetch?: QuantumMirrorFetch;
  resolveHostname?: QuantumHostnameResolver;
  zstdDecoder?: ZstdStreamDecoder;
  openSqlite?: OpenQuantumSqlite;
};

export type RunQuantumSyncOnceOptions = {
  config?: QuantumSyncConfigOverrides;
  environment?: QuantumSyncEnvironment;
  rowLimits?: Partial<QuantumSqliteRowLimits>;
  aggregateLimits?: Partial<QuantumSqliteAggregateLimits>;
  now?: () => Date;
  signal?: AbortSignal;
};

export async function runQuantumSyncOnce<Result>(
  dependencies: QuantumSyncDependencies<Result>,
  options: RunQuantumSyncOnceOptions = {},
): Promise<QuantumSyncOnceResult<Result>> {
  const contract = resolveQuantumSyncContract(options.config, options.environment);
  const loadEvents = dependencies.loadEvents ?? createNostrEventLoader();
  const rawEvents = await loadEvents({
    relays: contract.relays,
    signerPubkey: contract.signerPubkey,
    kind: QUANTUM_MANIFEST_KIND,
    dTag: contract.dTag,
    maxManifestBytes: contract.limits.maxManifestBytes,
    maxEventsPerRelay: contract.limits.maxEventsPerRelay,
    relayTimeoutMs: contract.limits.relayTimeoutMs,
    signal: options.signal,
  });
  const selection = await selectLatestQuantumManifest(rawEvents, contract, dependencies.verifyEventSignature, {
    now: options.now,
  });
  const chunk = selection.manifest.chunks[0];
  const downloaded = await downloadQuantumChunk(chunk, contract.limits, {
    fetch: dependencies.fetch,
    resolveHostname: dependencies.resolveHostname,
    signal: options.signal,
  });
  try {
    const decompressed = await decompressQuantumSnapshot(downloaded.filePath, contract.limits.maxDecompressedBytes, {
      decoder: dependencies.zstdDecoder,
      signal: options.signal,
    });
    await downloaded.dispose();
    try {
      const validated = await validateQuantumSqliteFile(decompressed.filePath, {
        openSqlite: dependencies.openSqlite,
        rowLimits: options.rowLimits,
        aggregateLimits: options.aggregateLimits,
      });
      await decompressed.dispose();

      const snapshot: ValidatedQuantumSnapshot = Object.freeze({
        eventId: selection.event.id,
        eventPubkey: selection.event.pubkey,
        eventCreatedAt: selection.event.created_at,
        dTag: contract.dTag,
        board: selection.manifest.board,
        source: selection.manifest.source,
        manifestCreatedAt: selection.manifest.created_at,
        chunkName: chunk.name,
        chunkSha256: downloaded.sha256,
        compressedSize: downloaded.size,
        decompressedSha256: decompressed.sha256,
        decompressedSize: decompressed.size,
        selectedMirrorUrl: downloaded.mirrorUrl,
        rows: validated.rows,
        summary: validated.summary,
      });

      let importResult: Result;
      try {
        importResult = await dependencies.importSnapshot(snapshot, options.signal);
      } catch (error) {
        throw new QuantumSyncError('IMPORT_FAILED', 'Validated Quantum snapshot import failed.', { cause: error });
      }

      return Object.freeze({
        contract,
        snapshot,
        importResult,
        rejectedEventCount: selection.rejectedEventCount,
      });
    } finally {
      await decompressed.dispose();
    }
  } finally {
    await downloaded.dispose();
  }
}
