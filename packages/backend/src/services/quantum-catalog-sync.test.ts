import { describe, expect, it } from 'vite-plus/test';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NostrEvent } from '@boardsesh/quantum-sync';
import { verifyQuantumManifestSignature } from './quantum-catalog-sync';

describe('Quantum manifest signature verifier', () => {
  it('accepts a valid BIP-340 signature and fails closed on tampering or malformed hex', async () => {
    const secretKey = new Uint8Array(32);
    secretKey[31] = 1;
    const eventIdBytes = new Uint8Array(32).fill(2);
    const publicKey = schnorr.getPublicKey(secretKey);
    const signature = schnorr.sign(eventIdBytes, secretKey, new Uint8Array(32));
    const event: NostrEvent = {
      id: Buffer.from(eventIdBytes).toString('hex'),
      pubkey: Buffer.from(publicKey).toString('hex'),
      created_at: 1_800_000_000,
      kind: 30_078,
      tags: [['d', 'cruxcoach/quantum-db']],
      content: '{}',
      sig: Buffer.from(signature).toString('hex'),
    };

    await expect(verifyQuantumManifestSignature(event)).resolves.toBe(true);
    await expect(verifyQuantumManifestSignature({ ...event, id: `${event.id.slice(0, -2)}03` })).resolves.toBe(false);
    await expect(verifyQuantumManifestSignature({ ...event, sig: 'not-hex' })).resolves.toBe(false);
  });
});
