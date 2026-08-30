import { Buffer } from 'node:buffer';
import {
  QUANTUM_CHUNK_NAME,
  QUANTUM_CHUNK_TYPE,
  QUANTUM_MANIFEST_BOARD,
  QUANTUM_MANIFEST_COMPRESSION,
  QUANTUM_MANIFEST_VERSION,
} from './constants';
import type { QuantumSyncContract } from './config';
import { QuantumSyncError } from './errors';
import type { NostrEvent, QuantumManifest, QuantumManifestChunk } from './types';

const MANIFEST_KEYS = ['board', 'chunks', 'compression', 'created_at', 'source', 'v'] as const;
const CHUNK_KEYS = ['name', 'sha256', 'size', 'type', 'urls'] as const;

export function parseQuantumManifest(
  event: Readonly<NostrEvent>,
  contract: Readonly<QuantumSyncContract>,
): Readonly<QuantumManifest> {
  if (Buffer.byteLength(event.content, 'utf8') > contract.limits.maxManifestBytes) {
    throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest content exceeds the configured byte limit.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(event.content);
  } catch (error) {
    throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest content is not valid JSON.', { cause: error });
  }

  const manifestRecord = requireRecord(decoded, 'Quantum manifest');
  requireExactKeys(manifestRecord, MANIFEST_KEYS, 'Quantum manifest');
  if (manifestRecord.v !== QUANTUM_MANIFEST_VERSION) {
    throw new QuantumSyncError('MANIFEST_INVALID', `Quantum manifest version must be ${QUANTUM_MANIFEST_VERSION}.`);
  }
  if (manifestRecord.board !== QUANTUM_MANIFEST_BOARD) {
    throw new QuantumSyncError('MANIFEST_INVALID', `Quantum manifest board must be ${QUANTUM_MANIFEST_BOARD}.`);
  }
  if (manifestRecord.source !== contract.source) {
    throw new QuantumSyncError('MANIFEST_INVALID', `Quantum manifest source must be ${contract.source}.`);
  }
  if (manifestRecord.compression !== QUANTUM_MANIFEST_COMPRESSION) {
    throw new QuantumSyncError(
      'MANIFEST_INVALID',
      `Quantum manifest compression must be ${QUANTUM_MANIFEST_COMPRESSION}.`,
    );
  }
  if (!Number.isSafeInteger(manifestRecord.created_at) || (manifestRecord.created_at as number) < 0) {
    throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest created_at must be a non-negative integer.');
  }
  if (manifestRecord.created_at !== event.created_at) {
    throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest created_at must equal its Nostr event timestamp.');
  }
  if (!Array.isArray(manifestRecord.chunks) || manifestRecord.chunks.length !== 1) {
    throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest must contain exactly one snapshot chunk.');
  }

  const chunk = parseChunk(manifestRecord.chunks[0], contract);
  return Object.freeze({
    v: QUANTUM_MANIFEST_VERSION,
    board: QUANTUM_MANIFEST_BOARD,
    source: contract.source,
    created_at: event.created_at,
    compression: QUANTUM_MANIFEST_COMPRESSION,
    chunks: Object.freeze([chunk]) as readonly [QuantumManifestChunk],
  });
}

function parseChunk(value: unknown, contract: Readonly<QuantumSyncContract>): Readonly<QuantumManifestChunk> {
  const chunkRecord = requireRecord(value, 'Quantum manifest chunk');
  requireExactKeys(chunkRecord, CHUNK_KEYS, 'Quantum manifest chunk');

  if (chunkRecord.name !== QUANTUM_CHUNK_NAME || chunkRecord.type !== QUANTUM_CHUNK_TYPE) {
    throw new QuantumSyncError(
      'MANIFEST_INVALID',
      `Quantum manifest chunk must be ${QUANTUM_CHUNK_NAME} with type ${QUANTUM_CHUNK_TYPE}.`,
    );
  }
  if (typeof chunkRecord.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(chunkRecord.sha256)) {
    throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest chunk sha256 must be lowercase hexadecimal.');
  }
  if (
    !Number.isSafeInteger(chunkRecord.size) ||
    (chunkRecord.size as number) <= 0 ||
    (chunkRecord.size as number) > contract.limits.maxCompressedBytes
  ) {
    throw new QuantumSyncError(
      'MANIFEST_INVALID',
      'Quantum manifest chunk size must be positive and within the configured compressed-size cap.',
    );
  }
  if (
    !Array.isArray(chunkRecord.urls) ||
    chunkRecord.urls.length === 0 ||
    chunkRecord.urls.length > contract.limits.maxMirrorUrls
  ) {
    throw new QuantumSyncError(
      'MANIFEST_INVALID',
      `Quantum manifest chunk must have 1-${contract.limits.maxMirrorUrls} mirror URLs.`,
    );
  }

  const uniqueUrls = new Set<string>();
  for (const candidate of chunkRecord.urls) {
    if (typeof candidate !== 'string') {
      throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum mirror URLs must be strings.');
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum mirror URL is invalid.');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new QuantumSyncError(
        'MANIFEST_INVALID',
        'Quantum mirror URLs must be credential-free HTTPS URLs without fragments.',
      );
    }
    const normalized = parsed.toString();
    if (uniqueUrls.has(normalized)) {
      throw new QuantumSyncError('MANIFEST_INVALID', 'Quantum manifest contains a duplicate mirror URL.');
    }
    uniqueUrls.add(normalized);
  }

  return Object.freeze({
    name: QUANTUM_CHUNK_NAME,
    type: QUANTUM_CHUNK_TYPE,
    sha256: chunkRecord.sha256,
    size: chunkRecord.size as number,
    urls: Object.freeze([...uniqueUrls]),
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuantumSyncError('MANIFEST_INVALID', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((actualKey, index) => actualKey !== sortedExpectedKeys[index])
  ) {
    throw new QuantumSyncError('MANIFEST_INVALID', `${label} has unsupported or missing fields.`);
  }
}
