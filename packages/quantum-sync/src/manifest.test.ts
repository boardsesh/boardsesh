import { describe, expect, it, vi } from 'vitest';
import { resolveQuantumSyncContract } from './config';
import { parseQuantumManifest } from './manifest';
import { selectLatestQuantumManifest } from './nostr';
import { createSyntheticManifestEvent } from './test-fixtures';

const COMPRESSED_BYTES = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 1);

describe('Quantum Nostr manifest selection', () => {
  it('keeps trust anchors fixed while allowing operational relay configuration', () => {
    const defaults = resolveQuantumSyncContract({}, {});
    expect(defaults.signerPubkey).toBe('70b2740bff77cf65743a7d6ffa5465b3a27105ae26123458cf5450eafb1bd68d');
    expect(defaults.dTag).toBe('cruxcoach/quantum-db');
    expect(defaults.source).toBe('ewalls-authorized-snapshot');
    expect(defaults.relays).toHaveLength(6);

    const configured = resolveQuantumSyncContract(
      { relays: ['wss://relay.example'] },
      {
        QUANTUM_SYNC_SIGNER_PUBKEY: 'b'.repeat(64),
        QUANTUM_SYNC_D_TAG: 'test/quantum',
        QUANTUM_SYNC_SOURCE: 'test-source',
      },
    );
    expect(configured).toMatchObject({
      dTag: defaults.dTag,
      source: defaults.source,
      signerPubkey: defaults.signerPubkey,
      relays: ['wss://relay.example/'],
    });
  });

  it('selects the newest valid signed replaceable event and ignores a newer invalid signature', async () => {
    const older = createSyntheticManifestEvent({ compressed: COMPRESSED_BYTES, createdAt: 1_800_000_000 });
    const newer = createSyntheticManifestEvent({ compressed: COMPRESSED_BYTES, createdAt: 1_800_000_001 });
    const verifySignature = vi.fn(async (event: { id: string }) => event.id === older.id);

    const selected = await selectLatestQuantumManifest(
      [newer, older],
      resolveQuantumSyncContract({}, {}),
      verifySignature,
      { now: () => new Date('2027-02-01T00:00:00.000Z') },
    );

    expect(selected.event.id).toBe(older.id);
    expect(selected.rejectedEventCount).toBe(1);
    expect(verifySignature).toHaveBeenCalledTimes(2);
  });

  it('rejects an ambiguous d-tag before invoking the signature verifier', async () => {
    const event = createSyntheticManifestEvent({ compressed: COMPRESSED_BYTES });
    const ambiguous = { ...event, tags: [...event.tags, ['d', 'cruxcoach/quantum-db']] };
    const verifySignature = vi.fn(() => true);

    await expect(
      selectLatestQuantumManifest([ambiguous], resolveQuantumSyncContract({}, {}), verifySignature, {
        now: () => new Date('2027-02-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'NOSTR_NO_VALID_MANIFEST' });
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('enforces source, chunk identity, size, hash, and HTTPS mirrors', () => {
    const contract = resolveQuantumSyncContract({}, {});
    const wrongSource = createSyntheticManifestEvent({ compressed: COMPRESSED_BYTES, source: 'untrusted-source' });
    expect(() => parseQuantumManifest(wrongSource, contract)).toThrow(/source/);

    const wrongChunk = createSyntheticManifestEvent({
      compressed: COMPRESSED_BYTES,
      mutateManifest: (manifest) => {
        const chunks = manifest.chunks as Array<Record<string, unknown>>;
        chunks[0] = { ...chunks[0], name: 'other' };
      },
    });
    expect(() => parseQuantumManifest(wrongChunk, contract)).toThrow(/quantum_snapshot_v1/);

    const insecureMirror = createSyntheticManifestEvent({
      compressed: COMPRESSED_BYTES,
      url: 'http://mirror.example/a',
    });
    expect(() => parseQuantumManifest(insecureMirror, contract)).toThrow(/HTTPS/);
  });
});
