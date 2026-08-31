import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { QUANTUM_MANIFEST_KIND } from './constants';
import type { QuantumSyncContract } from './config';
import { QuantumSyncError } from './errors';
import { parseQuantumManifest } from './manifest';
import type { NostrEvent, QuantumManifestSelection, VerifyNostrEventSignature } from './types';

export type SelectQuantumManifestOptions = {
  now?: () => Date;
};

export async function selectLatestQuantumManifest(
  rawEvents: readonly unknown[],
  contract: Readonly<QuantumSyncContract>,
  verifySignature: VerifyNostrEventSignature,
  options: SelectQuantumManifestOptions = {},
): Promise<Readonly<QuantumManifestSelection>> {
  const nowSeconds = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  const candidates: Array<Omit<QuantumManifestSelection, 'rejectedEventCount'>> = [];
  let rejectedEventCount = 0;

  for (const rawEvent of rawEvents) {
    try {
      const event = parseNostrEvent(rawEvent, contract);
      if (event.created_at > nowSeconds + contract.limits.maxFutureEventSeconds) {
        throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Quantum manifest event timestamp is too far in the future.');
      }
      if (!hasExactDTag(event.tags, contract.dTag)) {
        throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Quantum manifest event has the wrong or ambiguous d-tag.');
      }
      if (!nostrEventIdMatches(event)) {
        throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Quantum manifest event id does not match its payload.');
      }
      if (!(await verifySignature(event))) {
        throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Quantum manifest event signature is invalid.');
      }
      const manifest = parseQuantumManifest(event, contract);
      candidates.push({ event, manifest });
    } catch {
      rejectedEventCount += 1;
    }
  }

  candidates.sort((left, right) => {
    const timestampOrder = right.event.created_at - left.event.created_at;
    return timestampOrder !== 0 ? timestampOrder : right.event.id.localeCompare(left.event.id);
  });
  const selected = candidates[0];
  if (!selected) {
    throw new QuantumSyncError(
      'NOSTR_NO_VALID_MANIFEST',
      `No valid Quantum manifest event was found (${rejectedEventCount} rejected).`,
    );
  }

  return Object.freeze({
    event: selected.event,
    manifest: selected.manifest,
    rejectedEventCount,
  });
}

export function computeNostrEventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return createHash('sha256').update(serialized).digest('hex');
}

export function nostrEventIdMatches(event: Readonly<NostrEvent>): boolean {
  const expected = Buffer.from(
    computeNostrEventId({
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    }),
    'hex',
  );
  const actual = Buffer.from(event.id, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseNostrEvent(value: unknown, contract: Readonly<QuantumSyncContract>): Readonly<NostrEvent> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Nostr event must be an object.');
  }
  const record = value as Record<string, unknown>;
  const id = requireLowerHex(record.id, 64, 'id');
  const pubkey = requireLowerHex(record.pubkey, 64, 'pubkey');
  const sig = requireLowerHex(record.sig, 128, 'sig');
  if (pubkey !== contract.signerPubkey) {
    throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Quantum manifest event signer is not trusted.');
  }
  if (!Number.isSafeInteger(record.created_at) || (record.created_at as number) < 0) {
    throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Nostr event created_at must be a non-negative integer.');
  }
  if (record.kind !== QUANTUM_MANIFEST_KIND) {
    throw new QuantumSyncError('NOSTR_EVENT_INVALID', `Nostr event kind must be ${QUANTUM_MANIFEST_KIND}.`);
  }
  if (typeof record.content !== 'string') {
    throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Nostr event content must be a string.');
  }
  if (!Array.isArray(record.tags) || record.tags.length > 256) {
    throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Nostr event tags must be an array with at most 256 entries.');
  }

  const tags = record.tags.map((tag): readonly string[] => {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > 16) {
      throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Nostr event tag shape is invalid.');
    }
    const stringTag = tag.map((part) => {
      if (typeof part !== 'string' || Buffer.byteLength(part, 'utf8') > 4096) {
        throw new QuantumSyncError('NOSTR_EVENT_INVALID', 'Nostr event tag values must be bounded strings.');
      }
      return part;
    });
    return Object.freeze(stringTag);
  });

  return Object.freeze({
    id,
    pubkey,
    sig,
    created_at: record.created_at as number,
    kind: QUANTUM_MANIFEST_KIND,
    tags: Object.freeze(tags),
    content: record.content,
  });
}

function requireLowerHex(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw new QuantumSyncError(
      'NOSTR_EVENT_INVALID',
      `Nostr event ${field} must be ${length} lowercase hexadecimal characters.`,
    );
  }
  return value;
}

function hasExactDTag(tags: readonly (readonly string[])[], expectedDTag: string): boolean {
  const dTags = tags.filter((tag) => tag[0] === 'd');
  return dTags.length === 1 && dTags[0]?.length === 2 && dTags[0][1] === expectedDTag;
}
